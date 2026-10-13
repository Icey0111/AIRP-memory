// 三阶抽取管线: 对话文本 -> LLM 属性观察抽取 -> embedding -> supersedes 判定 -> 落库
// 画像重归纳: 当前生效观察块 -> LLM 归纳 -> character_profiles (带溯源)
import { findOrCreatePerson, findOrCreateLocation } from './entityService.js';
import { addChunk, currentChunks } from './chunkService.js';
import { upsertProfileEntry } from './profileService.js';
import { cosine, unpackVector } from './embeddingClient.js';
import {
  THRESHOLDS, CHUNKABLE_ENTITY_TYPES, ASPECT_SUGGESTIONS, CHUNK_DEFAULTS,
} from '../domain/constants.js';

// 同实体同维度下, 新观察与旧块余弦 >= 阈值 => 视为"同一属性的更新", 建立覆盖链
// 阈值口径来自 domain/constants.js (与 GET /api/meta 同源)
const SUPERSEDE_THRESHOLD = THRESHOLDS.supersedeSimilarity;
const CHUNKABLE = new Set(CHUNKABLE_ENTITY_TYPES);

const EXTRACT_SYSTEM = `你是角色扮演对话的属性观察抽取器。从给定对话中抽取关于人物/地点的细粒度属性观察。
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
没有可抽取内容时输出 {"observations": []}`;

const DERIVE_SYSTEM = `你是角色画像归纳器。给定一个角色的若干条属性观察(均为当前生效), 归纳为稳定的画像键值对。
规则: 保留具体细节, 每条 value 不超过两句话; 观察间矛盾时以较新的为准; 不要编造观察中没有的信息。
严格输出 JSON:
{"entries": [{"category": "维度分类", "key": "属性名", "value": "归纳结果"}]}`;

function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- 属性观察抽取 ----------
export async function extractAttributes(db, { llm, embed, chatId, text, sourceMessageIds = [] }) {
  const raw = await llm.chat({ system: EXTRACT_SYSTEM, user: text });
  const data = parseJson(raw);
  const observations = (data.observations ?? []).filter((o) => o?.entity_name && o?.aspect && o?.content);
  if (observations.length === 0) return { chunks: [], skipped: 0 };

  // 1) 实体解析 (只支持 CHUNKABLE_ENTITY_TYPES, 其余类型跳过并计数)
  const resolved = [];
  let skipped = 0;
  for (const o of observations) {
    if (!CHUNKABLE.has(o.entity_type)) {
      skipped++;
      continue;
    }
    const entity = o.entity_type === 'person'
      ? findOrCreatePerson(db, { name: o.entity_name })
      : findOrCreateLocation(db, { name: o.entity_name });
    resolved.push({ ...o, entityId: entity.id, entityName: entity.name });
  }

  // 2) 批量 embedding
  const vecs = await embed.embed(resolved.map((o) => o.content));

  // 3) supersedes 判定 + 落库 (事务)
  const results = [];
  const insertAll = db.transaction(() => {
    for (let i = 0; i < resolved.length; i++) {
      const o = resolved[i];
      // 同实体+同维度的当前生效块, 找语义最近的
      const siblings = currentChunks(db, {
        entityType: o.entity_type, entityId: o.entityId, aspect: o.aspect, chatId,
      });
      let supersedesId = null;
      let bestSim = 0;
      for (const s of siblings) {
        const sv = unpackVector(s.embedding);
        if (!sv || sv.length !== vecs[i].length) continue;
        const sim = cosine(vecs[i], sv);
        if (sim > bestSim) { bestSim = sim; supersedesId = s.id; }
      }
      const isUpdate = bestSim >= SUPERSEDE_THRESHOLD;
      const id = addChunk(db, {
        entityType: o.entity_type, entityId: o.entityId,
        aspect: o.aspect, content: o.content,
        embeddingVec: vecs[i], embeddingModel: embed.model,
        supersedesChunkId: isUpdate ? supersedesId : null,
        sourceMessageIds, chatId, importance: o.importance ?? CHUNK_DEFAULTS.importance,
      });
      results.push({
        id, entityType: o.entity_type, entityName: o.entityName,
        aspect: o.aspect, content: o.content,
        supersedes: isUpdate ? supersedesId : null,
        similarity: Number(bestSim.toFixed(4)),
      });
    }
  });
  insertAll();

  return { chunks: results, skipped };
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
