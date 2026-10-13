// 二阶六要素抽取: 对话文本 -> LLM 结构化抽取 -> 实体图落库
// 流程: prompt -> llm.chat -> JSON 容错解析 -> 事务内 persist
//   (人物/地点别名归并 -> 时间点 -> 事件+参与者+一阶事件记忆 -> 因果边 -> 引用桥)
import { createMemory } from './memoryService.js';
import {
  findOrCreatePerson, findOrCreateLocation, findOrCreateTimePoint,
  findEventByTitle, createEvent, addEventParticipant, addEventLink, addEntityRef,
} from './entityService.js';

export const SYSTEM_PROMPT = `你是角色扮演剧情的要素抽取器。从剧情文本中抽取结构化要素, 严格输出 JSON, 不要输出任何其他文字。

输出格式:
{
  "people": [{"name": "人物主称呼", "aliases": ["别名"], "person_type": "main|npc|mentioned"}],
  "locations": [{"name": "地点名", "parent": "上级地点名或null"}],
  "time_point": {"label": "剧情时间描述, 如 '第三夜, 暴雨'", "seq": 数字或null},
  "events": [{
    "title": "事件短标题",
    "process": "经过",
    "cause_text": "起因",
    "result_text": "结果",
    "importance": 0.0到1.0,
    "participants": [{"name": "人名(与people一致, 可用别名)", "role": "发起者|参与者|对象|受害者|目击者|提及"}],
    "location": "地点名或null",
    "caused_by": "导致本事件的前置事件标题或null"
  }]
}

规则:
- 只抽取文本中明确出现或强烈暗示的信息, 不要编造
- 没有内容的字段给空字符串/空数组/null
- person_type: 用户扮演的主角为 main, 登场NPC为 npc, 仅被提及为 mentioned
- importance: 日常琐事0.2-0.4, 重要互动0.5-0.7, 剧情转折0.8-1.0
- 同一事件的多个人物都要登记 participants, 并标注角色

事件文本的信息正交性 (重要):
- title / process / cause_text / result_text 只写"发生了什么"(行为、抉择、转折),
  禁止写入时间、人物名、地点 —— 它们分别由 time_point / participants / location 字段表达,
  在正文里再写一遍等于同一信息出现两次 (注入时会占用双倍篇幅)。
- 正例: title "酒馆初遇", process "为躲雨推门而入, 与独坐角落的陌生人搭话"
- 反例: title "暴雨第三夜主角与艾拉在酒馆初遇" (时间、人物、地点全揉进标题)

不是事件的行为不要建事件:
- 日常重复的琐事 (买东西、吃饭、睡觉、寒暄、赶路) 不建事件 —— 它们属于属性观察,
  由另一套流程归纳为习惯 (aspect=habit), 反复出现只会被折叠成一条"稳定行为"。
- 只有推进剧情的叙事事件才建: 会面、冲突、抉择、转折、发现、承诺。
- 判断标准: 去掉这条事件, 剧情会不会少一个因果环节。会 -> 建; 不会 -> 不建。
- 反例: "艾拉去小卖部"、"两人吃晚饭"、"主角睡下" —— 这些不是叙事事件。`;

// 容错解析: 剥代码围栏, 截取首个 { 到末个 } 之间内容
export function parseJsonLoose(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 返回中未找到 JSON 对象');
  }
  return JSON.parse(s.slice(start, end + 1));
}

export async function extractSixElements(db, llm, { chatId, text, sourceMessageIds = [], writeMemory = true }) {
  if (!chatId) throw new Error('chatId 必填');
  if (!text || !text.trim()) throw new Error('text 不能为空');

  const raw = await llm.chat({ system: SYSTEM_PROMPT, user: text });
  const data = parseJsonLoose(raw);

  const result = db.transaction(() =>
    persistExtraction(db, data, { chatId, sourceMessageIds, writeMemory })
  )();
  return { ok: true, ...result, extracted: data };
}

function persistExtraction(db, data, { chatId, sourceMessageIds, writeMemory }) {
  const out = { people: [], locations: [], timePoint: null, events: [], links: [], memoryIds: [] };

  // 1) 人物与地点 (别名归并)
  for (const p of data.people ?? []) {
    if (!p?.name) continue;
    out.people.push(findOrCreatePerson(db, p));
  }
  for (const l of data.locations ?? []) {
    if (!l?.name) continue;
    out.locations.push(findOrCreateLocation(db, { name: l.name, parentName: l.parent }));
  }

  // 2) 时间点
  if (data.time_point?.label) {
    out.timePoint = findOrCreateTimePoint(db, { chatId, ...data.time_point });
  }

  // 3) 事件 (同聊天同标题幂等: 已存在则跳过创建, 返回已有)
  const titleToId = new Map();
  for (const ev of data.events ?? []) {
    if (!ev?.title) continue;
    const existing = findEventByTitle(db, chatId, ev.title);
    if (existing) {
      titleToId.set(ev.title, existing.id);
      out.events.push({ id: existing.id, title: ev.title, existed: true });
      continue;
    }

    // 3a) 一阶事件记忆 (文本层) + 溯源互链
    let memoryId = null;
    if (writeMemory) {
      const participantNames = (ev.participants ?? []).map((p) => p.name).join(' ');
      const mem = createMemory(db, {
        type: 'event',
        content: `${ev.title}: ${ev.process || ''}`.trim(),
        keywords: `${ev.title} ${participantNames}`.trim(),
        scope: 'chat',
        chatId,
        importance: ev.importance ?? 0.5,
        sourceMessageIds,
        inWorldTime: out.timePoint?.label ?? null,
      });
      memoryId = mem.id;
      out.memoryIds.push(memoryId);
    }

    // 3b) 事件本体
    const locationId = ev.location ? findOrCreateLocation(db, { name: ev.location }).id : null;
    const eventId = createEvent(db, {
      title: ev.title,
      process: ev.process ?? '',
      causeText: ev.cause_text ?? '',
      resultText: ev.result_text ?? '',
      timeId: out.timePoint?.id ?? null,
      locationId,
      chatId,
      memoryId,
      sourceMessageIds,
      importance: ev.importance ?? 0.5,
    });
    titleToId.set(ev.title, eventId);
    out.events.push({ id: eventId, title: ev.title, existed: false });

    // 3c) 参与者 (人名或别名解析到同一实体) + 引用桥
    for (const part of ev.participants ?? []) {
      if (!part?.name) continue;
      const person = findOrCreatePerson(db, { name: part.name });
      addEventParticipant(db, { eventId, personId: person.id, role: part.role || '参与者' });
      if (memoryId) addEntityRef(db, { memoryId, entityType: 'person', entityId: person.id });
    }
    if (memoryId && locationId) addEntityRef(db, { memoryId, entityType: 'location', entityId: locationId });
    if (memoryId) addEntityRef(db, { memoryId, entityType: 'event', entityId: eventId });
  }

  // 4) 因果边 (caused_by 按标题指向同批或既有事件)
  for (const ev of data.events ?? []) {
    if (!ev?.title || !ev?.caused_by) continue;
    const toId = titleToId.get(ev.title);
    let fromId = titleToId.get(ev.caused_by) ?? findEventByTitle(db, chatId, ev.caused_by)?.id;
    if (fromId && toId && addEventLink(db, { fromId, toId, relation: 'caused' })) {
      out.links.push({ from: ev.caused_by, to: ev.title, relation: 'caused' });
    }
  }

  return out;
}
