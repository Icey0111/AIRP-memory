// 述谓实例抽取 (V6, docs/verb-layer.md §9)
// 流程: prompt -> llm.chat -> JSON 容错解析 -> 事务内 persist
//   (人物/地点别名归并 -> 时间点 -> 实例本体 + 命题三轴 -> 题元参与者 -> 引用桥 -> 因果/条件边)
//
// 与旧版"六要素/事件抽取"的关键差别 (为什么必须改):
//   ① "事件"是模糊类型 (旧 prompt 要写"去掉这条会不会少一个因果环节"这种自白式判据);
//      改用**动词原语**: 谓语是枢纽, 施事/受事/时间/地点是它的题元边。
//   ② 旧版只有一种真值假设 —— 文本里的东西一律当事实, 于是"艾拉说明天去镇上买草药"
//      要么被丢弃 (伏笔消失), 要么被抽成事件 (**把意图写成事实**, 反向吃书)。
//      现在按②轴区分: 叙述者断言 vs 归属给某人, 后者进命题层且状态未决。
//   ③ 实体归并的触发权收窄: **只有叙述者断言可以触发** (人物层的"X 是 Y"一律落为命题),
//      否则不可逆的错误合并会发生 (§5.3)。
import { createMemory } from './memoryService.js';
import { alignPropositions } from './alignmentService.js';
import { VERB_LAYER } from '../domain/constants.js';
import {
  findOrCreatePerson, findOrCreateLocation, findOrCreateTimePoint,
  findEventByTitle, createEvent, addEventParticipant, addEventLink, addEntityRef,
} from './entityService.js';

export const SYSTEM_PROMPT = `你是角色扮演剧情的述谓抽取器。请把剧情文本拆成一条条**述谓实例**(谁—动词—谁), 严格输出 JSON, 不要输出任何其他文字。

输出格式:
{
  "people": [{"name": "人物主称呼", "aliases": ["别名"], "person_type": "main|npc|mentioned"}],
  "locations": [{"name": "地点名", "parent": "上级地点名或null"}],
  "time_point": {"label": "剧情时间描述, 如 '第三夜, 暴雨'", "seq": 数字或null},
  "instances": [{
    "label": "这条实例的短标签(建议填写: 同聊天内相同标签视为同一条实例, 用于去重; 留空则每次都会新建)",
    "verb_type": "动词, 尽量用常见词: 说/问/答/看/听/摸/去/来/给予/取/转交/承诺/威胁/救助/伤害/隐瞒/发现/决定/离开/战斗",
    "verb_surface": "原文里的动词写法(原样保留, 如 '嘟囔了一句')",
    "polarity": "+ 或 -",
    "tense": "past|now|future",
    "source_type": "narrator|attributed",
    "attitude": "说/认为/相信/希望/怀疑/假装/不知 (仅 attributed)",
    "source_name": "立场持有者姓名 (仅 attributed)",
    "participants": [{"name": "人名(可用别名)", "role": "发起者|参与者|对象|与事|受害者|目击者|工具|提及"}],
    "location": "地点名或null",
    "importance": 0.0到1.0,
    "result_note": "一句话描述这件事造成的状态变化(立场/属性/关系), 没有就留空",
    "comp": {"同上结构的实例": "命题宾语(从句), 最多一层"},
    "conditional": {"同上结构的实例": "条件前件(仅当本实例是某个条件的后果时)"},
    "alternatives": [{"同上结构的实例": "择一候选(仅当文本是「要么A要么B」时)"}],
    "caused_by": "导致本实例的前置实例的 label 或动词短语, 没有就 null"
  }]
}

【最重要的规则: 谁在担保这件事是真的】

- source_type="narrator": 叙述者直接讲述的事。只有它可以触发人物/地点的归并。
- source_type="attributed": 被某个人物说出、想到、相信、希望、怀疑、假装的**内容**。
  必须填 attitude 与 source_name。这类内容**不是事实**: 持有者可能撒谎、可能记错。

例:
  "艾拉说明天去镇上买草药"
    -> 实例: verb_type="说", source_type="attributed", attitude="说", source_name="艾拉",
       tense="future", participants=[{艾拉,发起者}],
       comp={verb_type:"去", participants=[{艾拉,发起者}], location:"镇上", tense:"future"}
    -> 内容(去买草药)是意图, 不是已发生的事。
  "艾拉说昨天她去买菜了"
    -> 实例: verb_type="说", source_type="attributed", attitude="说", source_name="艾拉",
       comp={verb_type:"去", participants=[{艾拉,发起者}], tense="past"}
    -> 从句指向过去也不代表它是事实, 它只是"艾拉这么说"。不要抽成叙述者实例。

【必须遵守的硬约束】

1. 只有叙述者断言才能触发实体归并。人物说"那人是艾拉"、"我不是你妹妹"这类**同一性断言**
   必须落为 attributed 实例 (verb_type 用 是/叫 之类), 绝不允许写成 people 的别名。
2. 意图、承诺、计划、预测、威胁 **必须**落 attributed + tense="future"。
   绝对不要把它们抽成叙述者实例 —— 那等于把没发生的事写成事实。
3. 实例正文里不要复述时间、人物、地点: 它们各有槽位 (tense / participants / location / time_point)。
   反例: label "暴雨第三夜主角与艾拉在酒馆初遇" (时间、人物、地点全揉进标签)。
4. 重复的日常行为照原样抽 (verb_type=去/吃/睡 等), 不要自己合并、不要加"又一次":
   折叠由写入管线完成, 复现次数本身就是"这是稳定行为"的证据。
5. label 可留空; 只抽取文本中明确出现或强烈暗示的内容, 不要编造。
6. participants 里的每个人名都要登记到 people 里; 没有内容的字段给空字符串/空数组/null。
7. 「要么 A 要么 B」这类**择一**必须用 alternatives 表达, 绝不能抽成两条并行实例 ——
   并行实例在读法上等于"两件事都发生了", 那是凭空编造。只有其中之一会被兑现, 其余作废。`;

/**
 * 身份锚定指令 (可选): 把角色卡名/用户名告诉抽取模型。
 * 背景: 文本里 AI 角色常以译名出现 (卡名 Seraphina, 文本写"塞拉菲娜"), 模型不知道两者是同一人,
 * 别名就落空, 下游画像归纳 (profiles-derive 按卡名找人) 会跳过。用户同理: "你"是用户,
 * 架构规定用户是一等节点 (person_type="main"), 但模型无从判断谁是用户。
 */
function buildIdentityAnchor({ characterName, userName }) {
  const lines = [];
  const cn = String(characterName ?? '').trim();
  const un = String(userName ?? '').trim();
  if (cn) {
    lines.push(`当前对话的 AI 角色卡名: 「${cn}」。该角色在文本中可能以别名/译名/称呼出现; `
      + `只要判定文本中的某个人物就是这个角色, 对应 people 条目的 aliases 数组必须包含「${cn}」。`);
  }
  if (un) {
    lines.push(`用户本人名称: 「${un}」。文本中以第二人称"你"或此名称指代的用户人物, `
      + `其 person_type 必须为 "main"; 其余人物不得为 "main"。`);
  }
  return lines.length ? `【身份锚定 (最高优先级)】\n${lines.join('\n')}` : '';
}

// 名字归一比较: trim + 小写。卡名/别名/用户名的匹配一律走这里, 不做模糊匹配 (宁可放过不可错并)。
function normName(s) {
  return String(s ?? '').trim().toLowerCase();
}

function personMatchesName(p, target) {
  const t = normName(target);
  if (!t) return false;
  if (normName(p?.name) === t) return true;
  try {
    const aliases = JSON.parse(p?.aliases ?? '[]');
    return Array.isArray(aliases) && aliases.some((a) => normName(a) === t);
  } catch {
    return false;
  }
}

/**
 * 身份锚定兜底 (确定性, 不依赖模型听话): 抽取结果落库后补齐硬规则。
 * 用户名: 命中的人物强制 person_type="main" (用户一等节点, 见注入图视角设计)。
 * 注意: 卡名→译名的跨语言映射 (Seraphina vs 塞拉菲娜) 本质需要语义判断, 确定性规则做不到,
 * 只能靠 buildIdentityAnchor 的 prompt 指令 + 下游按别名匹配。没有命中就什么都不做 —— 不猜、不新建、不错并。
 */
function applyIdentityAnchors(db, people, { userName }) {
  const un = String(userName ?? '').trim();
  if (!un) return;
  const ts = new Date().toISOString();
  const p = people.find((x) => personMatchesName(x, un));
  if (p && p.person_type !== 'main') {
    db.prepare("UPDATE people SET person_type = 'main', updated_at = ? WHERE id = ?").run(ts, p.id);
    p.person_type = 'main';
  }
}

// 容错解析: 剥代码围栏, 截取首个 { 到末个 } 之间内容
// (三个抽取器共用: chunkExtractionService / stanceExtractionService 均从此导入)
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

/**
 * 抽取述谓实例并落库。
 * @param {object} opts
 * @param {string|null} [opts.characterName] AI 角色卡名 (身份锚定: 并入别名, 供画像归纳按卡名找人)
 * @param {string|null} [opts.userName] 用户名 (身份锚定: 强制 person_type="main" 一等节点)
 * @returns {{ok:boolean, people:Array, locations:Array, timePoint:object|null,
 *            instances:Array, links:Array, memoryIds:Array, skipped:number}}
 */
export async function extractInstances(db, llm, {
  chatId, text, sourceMessageIds = [], writeMemory = true, characterName = null, userName = null,
}) {
  if (!chatId) throw new Error('chatId 必填');
  if (!text || !text.trim()) throw new Error('text 不能为空');

  const anchor = buildIdentityAnchor({ characterName, userName });
  const raw = await llm.chat({ system: SYSTEM_PROMPT, user: anchor ? `${anchor}\n\n---\n\n${text}` : text });
  const data = parseJsonLoose(raw);

  const result = db.transaction(() =>
    persistInstances(db, data, { chatId, sourceMessageIds, writeMemory, characterName, userName })
  )();

  // 写入后立即对齐: 新落库的事实可能兑现/推翻既有命题 (集合只含未决命题, 很小)。
  // 对齐失败绝不影响抽取本身 —— 宁可这轮没对齐上, 也不能让抽取整批失败。
  let aligned = null;
  try {
    aligned = alignPropositions(db, { chatId });
  } catch (err) {
    console.warn(`[alignment] 抽取后对齐失败, 本轮跳过: ${err.message}`);
  }

  return { ok: true, ...result, extracted: data, aligned };
}

/** 兼容旧名 (既有调用方与文档) */
export const extractSixElements = extractInstances;

const MAX_DEPTH = VERB_LAYER.alignment.maxNestingDepth;

/** 轴③的缺省: 归属命题一律未决; 叙述者对未来的断言也是未决 (担保可信但尚未发生) */
function resolveStatus({ sourceType, tense }) {
  if (sourceType === 'attributed') return VERB_LAYER.defaults.attributedStatus;
  return tense === 'future'
    ? VERB_LAYER.defaults.narratorFutureStatus
    : VERB_LAYER.defaults.status;
}

function persistInstances(db, data, { chatId, sourceMessageIds, writeMemory, characterName, userName }) {
  const out = {
    people: [], locations: [], timePoint: null,
    instances: [], links: [], memoryIds: [], skipped: 0,
  };

  // 1) 人物与地点 (别名归并)
  for (const p of data.people ?? []) {
    if (!p?.name) continue;
    out.people.push(findOrCreatePerson(db, {
      name: p.name,
      aliases: p.aliases ?? [],
      personType: p.person_type ?? 'npc',
    }));
  }
  // 身份锚定兜底: 用户强制 main 一等节点 (确定性规则)。卡名→译名靠 prompt 指令 + 下游别名匹配。
  applyIdentityAnchors(db, out.people, { userName });
  for (const l of data.locations ?? []) {
    if (!l?.name) continue;
    out.locations.push(findOrCreateLocation(db, { name: l.name, parentName: l.parent }));
  }

  // 2) 时间点
  if (data.time_point?.label) {
    out.timePoint = findOrCreateTimePoint(db, { chatId, ...data.time_point });
  }

  // 3) 实例 + 嵌套 (comp / conditional)
  const labelToId = new Map();
  const ctx = {
    chatId, sourceMessageIds, writeMemory, out,
    labelToId, timePoint: out.timePoint,
  };
  for (const inst of data.instances ?? []) {
    persistOne(db, inst, ctx, 1, null);
  }

  // 4) 因果边: 全部实例落库后再解析, 保证前向引用 (caused_by 指向同批靠后的实例) 也能连上
  for (const inst of data.instances ?? []) {
    if (!inst?.caused_by) continue;
    const toId = labelToId.get(inst.label) ?? labelToId.get(inst.verb_type);
    if (!toId) continue;
    const fromId = labelToId.get(inst.caused_by) ?? findEventByTitle(db, chatId, inst.caused_by)?.id;
    if (fromId && addEventLink(db, { fromId, toId, relation: 'caused' })) {
      out.links.push({ from: inst.caused_by, to: inst.label ?? inst.verb_type, relation: 'caused' });
    }
  }

  return out;
}

/**
 * 落库单条实例 (含嵌套)。
 * 深度上限 MAX_DEPTH: 超出直接丢弃并计数 —— 不设限的话跨角色传话会变成传话游戏。
 */
function persistOne(db, inst, ctx, depth, parent) {
  const { chatId, sourceMessageIds, writeMemory, out } = ctx;
  if (!inst || depth > MAX_DEPTH) { out.skipped++; return null; }

  const verbType = String(inst.verb_type ?? '').trim();
  const verbSurface = String(inst.verb_surface ?? '').trim();
  const label = String(inst.label ?? '').trim();
  const title = label || verbSurface || verbType;
  if (!title) { out.skipped++; return null; }

  // 来源: 实例自己声明优先; 否则**从父实例继承** —— 从句/条件前件默认与其宿主同源。
  // 这一条不可省: "艾拉说[她明天去镇上]" 里的从句天然是归属内容 (艾拉的意图), 不是叙述者事实。
  // 若不继承, 从句会被当成事实写进 v_facts —— 正是要防的那种"把意图写成事实"。
  // 显式声明 source_type 仍然优先 (用于"叙述者后来确认了某事"的追认场景)。
  const sourceType = inst.source_type === 'attributed' ? 'attributed'
    : (inst.source_type === 'narrator' ? 'narrator'
      : (parent?.sourceType ?? 'narrator'));
  const attitude = inst.attitude ?? (inst.source_type ? null : (parent?.attitude ?? null));
  const sourceName = inst.source_name ?? (inst.source_type ? null : (parent?.sourceName ?? null));
  const isNarrator = sourceType === 'narrator';
  // 关键: 只有叙述者断言可触发别名归并 (人物层的同一性断言一律只是命题, §5.3)
  const mergeAliases = isNarrator;
  const tense = VERB_LAYER.tenses.some((t) => t.value === inst.tense)
    ? inst.tense : VERB_LAYER.defaults.tense;
  // 幂等: **只在有 label 时**按标签去重。
  // 无标签实例不能用动词当身份键 —— 两条不同的从句可能同为 verb_type='去',
  // 那样第二条会被误判为"已存在"而整条丢失 (实测踩到)。
  const existing = label ? findEventByTitle(db, chatId, title) : null;
  let instanceId;
  if (existing) {
    instanceId = existing.id;
    out.instances.push({ id: instanceId, title, verbType, sourceType, existed: true });
  } else {
    // 一阶事件记忆: 只给叙述者断言写 (归属命题不得污染 FTS 检索)
    let memoryId = null;
    if (writeMemory && isNarrator) {
      const participantNames = (inst.participants ?? []).map((p) => p.name).join(' ');
      const mem = createMemory(db, {
        type: 'event',
        content: `${title}${inst.result_note ? `: ${inst.result_note}` : ''}`,
        keywords: `${verbType} ${participantNames}`.trim(),
        scope: 'chat',
        chatId,
        importance: inst.importance ?? 0.5,
        sourceMessageIds,
        inWorldTime: ctx.timePoint?.label ?? null,
      });
      memoryId = mem.id;
      out.memoryIds.push(memoryId);
    }

    // 立场持有者: "某某确实说了/信了"属于叙述者担保的事实, 允许归并
    const holderId = (sourceType === 'attributed' && sourceName)
      ? findOrCreatePerson(db, { name: sourceName }).id
      : null;

    const locationId = inst.location
      ? (findOrCreateLocation(db, { name: inst.location })?.id ?? null)
      : null;

    instanceId = createEvent(db, {
      title,
      process: verbSurface,
      resultText: inst.result_note ?? '',
      timeId: ctx.timePoint?.id ?? null,
      locationId,
      chatId,
      memoryId,
      sourceMessageIds,
      importance: inst.importance ?? 0.5,
      verbType,
      verbSurface,
      polarity: inst.polarity === '-' ? '-' : VERB_LAYER.defaults.polarity,
      sourceType,
      sourcePersonId: holderId,
      attitude: sourceType === 'attributed' ? attitude : null,
      tense,
      status: resolveStatus({ sourceType, tense }),
      parentInstanceId: parent?.id ?? null,
      parentRole: parent?.role ?? null,
    });
    out.instances.push({ id: instanceId, title, verbType, sourceType, existed: false });

    // 题元参与者 + 引用桥
    for (const part of inst.participants ?? []) {
      if (!part?.name) continue;
      const person = findOrCreatePerson(db, { name: part.name, mergeAliases });
      addEventParticipant(db, {
        eventId: instanceId,
        personId: person.id,
        role: part.role || VERB_LAYER.thematicRoles[1].value,
      });
      if (memoryId) addEntityRef(db, { memoryId, entityType: 'person', entityId: person.id });
    }
    if (memoryId && locationId) {
      addEntityRef(db, { memoryId, entityType: 'location', entityId: locationId });
    }
    if (memoryId) addEntityRef(db, { memoryId, entityType: 'event', entityId: instanceId });
  }

  // 标签索引 (供 caused_by 与后续引用解析)
  if (label) ctx.labelToId.set(label, instanceId);
  ctx.labelToId.set(title, instanceId);
  if (verbType) ctx.labelToId.set(verbType, instanceId);

  // 子实例共用的来源继承 (见上方注释: 显式声明优先, 否则随宿主)
  const inherit = { sourceType, attitude, sourceName };

  // 择一候选: 子实例 + parent_role='alt' (一个被兑现时其余作废, 见 alignmentService)
  if (Array.isArray(inst.alternatives)) {
    for (const alt of inst.alternatives) {
      if (depth < MAX_DEPTH) {
        persistOne(db, alt, ctx, depth + 1, { id: instanceId, role: 'alt', ...inherit });
      } else {
        out.skipped++;
      }
    }
  }

  // 命题宾语 (从句): 子实例 + parent_role='comp'
  if (inst.comp) {
    if (depth < MAX_DEPTH) {
      persistOne(db, inst.comp, ctx, depth + 1, { id: instanceId, role: 'comp', ...inherit });
    } else {
      out.skipped++;
    }
  }

  // 条件前件: 子实例 + 条件边 (条件 -> 后果)
  if (inst.conditional) {
    if (depth < MAX_DEPTH) {
      const condId = persistOne(db, inst.conditional, ctx, depth + 1, { id: instanceId, role: 'cond', ...inherit });
      if (condId) {
        const condTitle = inst.conditional.label
          || inst.conditional.verb_surface || inst.conditional.verb_type;
        if (addEventLink(db, { fromId: condId, toId: instanceId, relation: 'conditional' })) {
          out.links.push({ from: condTitle, to: title, relation: 'conditional' });
        }
      }
    } else {
      out.skipped++;
    }
  }

  return instanceId;
}
