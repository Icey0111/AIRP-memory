// 三阶抽取管线: 对话文本 -> LLM 属性观察抽取 -> embedding -> 槽位判定 -> 落库
// 画像重归纳: 当前生效观察块 -> LLM 归纳 -> character_profiles (带溯源)
//
// V8: 落库走 chunkService.recordObservation —— 重述不新增行 (只 confirms+1),
// 措辞变了才写新行并留下 supersede_similarity 供审计与校准。判定细节在 chunkService 里。
import { findOrCreatePerson, findOrCreateLocation } from './entityService.js';
import { parseJsonLoose } from './extractionService.js';
import { currentChunks, recordObservation } from './chunkService.js';
import { upsertProfileEntry } from './profileService.js';
import {
  CHUNKABLE_ENTITY_TYPES, ASPECT_SUGGESTIONS, CHUNK_DEFAULTS,
} from '../domain/constants.js';

const CHUNKABLE = new Set(CHUNKABLE_ENTITY_TYPES);

export const EXTRACT_SYSTEM = `你是角色扮演对话的属性观察抽取器。从给定对话中抽取关于人物/地点的细粒度属性观察。
只抽取对话中明确表现或陈述的内容, 不要推测, 不要复述剧情事件本身(那是另一套流程的事)。
严格输出 JSON, 不要输出任何其他文字:
{
  "observations": [
    {
      "entity_type": "${CHUNKABLE_ENTITY_TYPES.join(' 或 ')}",
      "entity_name": "实体名称(用对话中的称呼)",
      "aspect": "维度, 人物用 ${ASPECT_SUGGESTIONS.person.join('/')} 等, 地点用 ${ASPECT_SUGGESTIONS.location.join('/')} 等",
      "content": "一条观察一句话, 保留原文细节, 不要总结掉具体信息",
      "importance": 0.0到1.0
    }
  ]
}
补充规则:
- 反复出现的日常行为是**观察**, 不是事件: "又去小卖部"、"照例先倒杯酒"、"每次见面都先嘲讽一句"
  这类内容写成 aspect=habit 的观察 (它表达的是稳定习惯, 强于一次性事件)。
- 同一条观察在不同时间反复出现时, 每次都照原样抽出来即可 (不要自己合并、不要加"又一次"之类的措辞):
  写入管线会做判等: **措辞一字不差**的重复观察只累加计数、不写新行 (这就是"稳定行为模式"的证据);
  措辞变了则视为值变了, 另存一行并留下覆盖链。所以不要为了"说得不一样"而改写, 照原样重复最有价值。
- 环境/氛围的**稳定**特征 (气味、光线、陈设) 也归 aspect=scene / atmosphere —— 它们会被归一成地点的一次速写。
没有可抽取内容时输出 {"observations": []}`;

const DERIVE_SYSTEM = `你是角色画像归纳器。给定一个角色的若干条属性观察(均为当前生效), 归纳为稳定的画像键值对。
规则: 保留具体细节, 每条 value 不超过两句话; 观察间矛盾时以较新的为准; 不要编造观察中没有的信息。
严格输出 JSON:
{"entries": [{"category": "维度分类", "key": "属性名", "value": "归纳结果"}]}`;

// JSON 解析统一用 parseJsonLoose (extractionService): 剥围栏 + 截取首尾大括号,
// LLM 在 JSON 前后加散文也能容错 —— 三个抽取器口径一致, 不再各写一份。
const parseJson = parseJsonLoose;

// ---------- 属性观察抽取 ----------
export async function extractAttributes(db, { llm, embed, chatId, text, sourceMessageIds = [] }) {
  const raw = await llm.chat({ system: EXTRACT_SYSTEM, user: text });
  const data = parseJson(raw);
  return await persistObservations(db, { embed, chatId, observations: data.observations ?? [], sourceMessageIds });
}

/**
 * 属性观察的落库段 (与 LLM 调用分离)。
 *
 * 之所以拆出来: 组合抽取 (mergedExtraction) 要让"事件/属性/立场"来自**同一次** LLM 输出,
 * 那么落库必须能单独复用 —— 否则一次调用省下的往返又会在落库层被复制一遍。
 *
 * @param {Array} observations 原始观察项 (含 entity_type/entity_name/aspect/content/event?)
 * @param {string|null} eventLabel 观察项引用的实例 label (由合并输出提供, 用于填事件锚点)
 */
export async function persistObservations(db, {
  embed, chatId, observations = [], sourceMessageIds = [], labels = null,
}) {
  const items = observations.filter((o) => o?.entity_name && o?.aspect && o?.content);
  if (items.length === 0) return { chunks: [], skipped: 0 };

  // 1) 实体解析 (只支持 CHUNKABLE_ENTITY_TYPES, 其余类型跳过并计数)
  const resolved = [];
  let skipped = 0;
  for (const o of items) {
    if (!CHUNKABLE.has(o.entity_type)) {
      skipped++;
      continue;
    }
    const entity = o.entity_type === 'person'
      ? findOrCreatePerson(db, { name: o.entity_name })
      : findOrCreateLocation(db, { name: o.entity_name });
    resolved.push({ ...o, entityId: entity.id, entityName: entity.name });
  }

  // 2) 批量 embedding (调用方保证 embed 可用; 不可用时不进本函数)
  const vecs = embed ? await embed.embed(resolved.map((o) => o.content)) : resolved.map(() => null);

  // 3) 槽位判定 + 落库 (事务)
  const results = [];
  const insertAll = db.transaction(() => {
    for (let i = 0; i < resolved.length; i++) {
      const o = resolved[i];
      const r = recordObservation(db, {
        entityType: o.entity_type, entityId: o.entityId,
        aspect: o.aspect, content: o.content,
        embeddingVec: vecs[i], embeddingModel: embed?.model ?? null,
        sourceMessageIds, chatId, importance: o.importance ?? CHUNK_DEFAULTS.importance,
        // 跨层锚点: 这条观察是被哪个事件触发的 (合并抽取时由输出的 event label 解析而来)
        validFromEventId: eventAnchor(o, labels),
      });
      results.push({
        id: r.id, entityType: o.entity_type, entityName: o.entityName,
        aspect: o.aspect, content: r.content,
        // V8: 建立 / 重述(不新增行) / 迁移 三种结构操作
        operation: r.operation,
        confirms: r.confirms,
        supersedes: r.supersedes,
        similarity: r.similarity,
        eventId: eventAnchor(o, labels),
      });
    }
  });
  insertAll();

  return { chunks: results, skipped };
}

/** 观察项声明的 event label → 事件 id (拿不到就留空, 绝不猜) */
function eventAnchor(o, labels) {
  const label = String(o?.event ?? o?.event_label ?? '').trim();
  if (!label || !labels) return null;
  return labels[label] ?? null;
}

// ---------- 画像重归纳: 当前生效观察块 -> character_profiles ----------
export async function deriveProfile(db, { llm, personId, characterId }) {
  const chunks = currentChunks(db, { entityType: 'person', entityId: personId });
  if (chunks.length === 0) return { entries: [], chunkCount: 0 };

  const digest = chunks.map((c) => `- [${c.aspect}] ${c.content}`).join('\n');
  const raw = await llm.chat({ system: DERIVE_SYSTEM, user: digest });
  const data = parseJson(raw);
  const entries = (data.entries ?? []).filter((e) => e?.category && e?.key && e?.value);

  const chunkIds = chunks.map((c) => c.id);
  const upsertAll = db.transaction(() => {
    for (const e of entries) {
      // 溯源: 只记该 category 下的块, 保持溯源精确
      const ids = chunks.filter((c) => c.aspect === e.category).map((c) => c.id);
      upsertProfileEntry(db, {
        characterId, category: e.category, key: e.key, value: e.value,
        derivedFromChunkIds: ids.length ? ids : chunkIds,
      });
    }
  });
  upsertAll();

  return { entries, chunkCount: chunks.length };
}
