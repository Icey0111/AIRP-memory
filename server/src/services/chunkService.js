// 三阶属性观察块: 写入 / 当前生效口径 / 暴力余弦召回
// 防吃书口径与立场层一致: is_active + 未被 supersede + 未过生效区间
//
// V8: 属性槽也走指针语义 (§16.10) —— 值没变不写新行, 只累加 confirms。
//   三种结构操作由 recordObservation 统一落库, 与 stanceService.applyStance 对称:
//     建立 ∅→A: 新行 (长文本在此写一次)
//     重述 A→A: **不新增行**, confirms+1 (规范化后文本判等, 与相似度无关)
//     迁移 A→B: 新行 + supersedes 指针 + supersede_similarity 留档
//   分工: **相似度决定"是不是同一条属性"(建不建链), 规范化判等决定"值动没动"**。
import { now, clamp01, normalizeSlotValue } from '../utils/text.js';
import { CHUNK_DEFAULTS, THRESHOLDS, RETRIEVAL_FALLBACK_DEFAULTS } from '../domain/constants.js';
import { packVector, unpackVector, cosine } from './embeddingClient.js';
import { findOrCreateValue } from './valueService.js';
import { ensureVocabulary } from './vocabularyService.js';

// 当前生效过滤 (SQL 片段): 未删除 + 未过期 + 未被新版本覆盖
const CURRENT = `
  c.is_active = 1
  AND c.valid_to_event_id IS NULL
  AND c.id NOT IN (SELECT supersedes_chunk_id FROM attribute_chunks WHERE supersedes_chunk_id IS NOT NULL)
`;

const SUPERSEDE_THRESHOLD = THRESHOLDS.supersedeSimilarity;

export function addChunk(db, {
  entityType, entityId, aspect, content,
  embeddingVec = null, embeddingModel = null,
  validFromEventId = null, validToEventId = null, supersedesChunkId = null,
  confirms = 0, supersedeSimilarity = null,
  memoryId = null, sourceMessageIds = [], chatId = null, importance = CHUNK_DEFAULTS.importance,
}) {
  if (!entityType || !entityId) throw new Error('entityType/entityId 必填');
  if (!aspect || !content) throw new Error('aspect/content 必填');
  // V10: 维度名也走词表 —— 归一后的词进文本列, 元素 id 进 aspect_id
  //   (旧口径只 findOrCreateValue 注册元素而不归一: 于是 appearance 与 外貌 是两条不同的槽)
  const aspectEl = ensureVocabulary(db, 'aspect', aspect);
  const aspectWord = aspectEl ? aspectEl.word : aspect;
  const ts = now();
  const info = db.prepare(`
    INSERT INTO attribute_chunks
      (entity_type, entity_id, aspect, aspect_id, content, embedding, embedding_model,
       valid_from_event_id, valid_to_event_id, supersedes_chunk_id,
       confirms, supersede_similarity,
       memory_id, source_message_ids, chat_id, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityType, entityId, aspectWord, aspectEl?.id ?? null, content,
    embeddingVec ? packVector(embeddingVec) : null, embeddingModel,
    validFromEventId, validToEventId, supersedesChunkId,
    confirms, supersedeSimilarity,
    memoryId, JSON.stringify(sourceMessageIds), chatId, clamp01(importance), ts, ts,
  );
  return Number(info.lastInsertRowid);
}

/**
 * 观察块的写入入口 —— 属性槽的三种指针操作 (V8)。
 *
 * 返回值 operation 三种:
 *   'create'  槽位从无到有, 写了新行;
 *   'confirm' **没有写新行**, 只是 confirms+1 (值没动);  id 指向原本就是当前值的那一行;
 *   'update'  值动了, 写了新行并指向前驱 (supersede_similarity 记下余弦, 审计/校准用)。
 *
 * 判定顺序很重要: **先判重述, 再判相似度**。
 * 若反过来的话,"同一句话重复出现"会因为相似度 ≥0.85 被当成一次更新而堆出一长串同值行 ——
 * 正是 V8 要消掉的那种伪迁移。
 */
export function recordObservation(db, {
  entityType, entityId, aspect, content,
  embeddingVec = null, embeddingModel = null,
  sourceMessageIds = [], chatId = null, importance = CHUNK_DEFAULTS.importance,
  memoryId = null, validFromEventId = null,
}) {
  if (!entityType || !entityId) throw new Error('entityType/entityId 必填');
  if (!aspect || !content) throw new Error('aspect/content 必填');

  // V10: **先归一, 再找槽位** —— 否则 appearance 与 外貌 会被当成两个槽,
  // 同一个维度的观察分成两条链, "新观察覆盖旧观察"的防吃书就失效了
  const aspectWord = ensureVocabulary(db, 'aspect', aspect)?.word ?? aspect;

  // 同实体 + 同维度 + 同聊天**当前生效**的块 = 该属性槽位下的现有链头们
  const heads = currentChunks(db, { entityType, entityId, aspect: aspectWord, chatId });

  // ① 重述: 规范化后文本完全相同 —— 就是同一个值被再次观察到
  const fingerprint = normalizeSlotValue(content);
  const restated = heads.find((h) => normalizeSlotValue(h.content) === fingerprint);
  if (restated) {
    confirmChunk(db, restated.id, { sourceMessageIds });
    return {
      id: restated.id,
      operation: 'confirm',
      confirms: (restated.confirms ?? 0) + 1,
      supersedes: null,
      similarity: null,
      content: restated.content,        // 文本一字不改: 复述不进库, 原文是首次出现的那份
    };
  }

  // ② 迁移: 找一个语义最近的旧值 (相似度只用来判断"是不是同一条属性")
  let supersedesId = null;
  let bestSim = 0;
  if (embeddingVec) {
    for (const h of heads) {
      const hv = unpackVector(h.embedding);
      if (!hv || hv.length !== embeddingVec.length) continue;
      const sim = cosine(embeddingVec, hv);
      if (sim > bestSim) { bestSim = sim; supersedesId = h.id; }
    }
  }
  const isUpdate = bestSim >= SUPERSEDE_THRESHOLD;

  // ③ 建立 / 迁移: 写一行
  const id = addChunk(db, {
    entityType, entityId, aspect: aspectWord, content,
    embeddingVec, embeddingModel,
    supersedesChunkId: isUpdate ? supersedesId : null,
    supersedeSimilarity: isUpdate ? Number(bestSim.toFixed(6)) : null,
    memoryId, validFromEventId, sourceMessageIds, chatId, importance,
  });
  return {
    id,
    operation: isUpdate ? 'update' : 'create',
    confirms: 0,
    supersedes: isUpdate ? supersedesId : null,
    similarity: isUpdate ? Number(bestSim.toFixed(4)) : null,
    content,
  };
}

/** 确认一次重述: 计数 +1, 顺带并上新的来源楼层。**不写新行, 不改文本**。 */
function confirmChunk(db, id, { sourceMessageIds = [] } = {}) {
  const row = db.prepare('SELECT source_message_ids FROM attribute_chunks WHERE id = ?').get(id);
  let merged = [];
  try { merged = JSON.parse(row?.source_message_ids ?? '[]'); } catch { merged = []; }
  for (const m of sourceMessageIds) if (!merged.includes(m)) merged.push(m);
  db.prepare(`
    UPDATE attribute_chunks
    SET confirms = confirms + 1, source_message_ids = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(merged), now(), id);
}


// 当前生效的观察块 (可按实体/维度/chat 过滤)
export function currentChunks(db, { entityType = null, entityId = null, aspect = null, chatId = null } = {}) {
  const conds = [CURRENT];
  const params = {};
  if (entityType) { conds.push('c.entity_type = @entityType'); params.entityType = entityType; }
  if (entityId) { conds.push('c.entity_id = @entityId'); params.entityId = entityId; }
  if (aspect) { conds.push('c.aspect = @aspect'); params.aspect = aspect; }
  if (chatId) { conds.push('(c.chat_id IS NULL OR c.chat_id = @chatId)'); params.chatId = chatId; }
  return db.prepare(`
    SELECT c.* FROM attribute_chunks c
    WHERE ${conds.join(' AND ')}
    ORDER BY c.importance DESC, c.id DESC
  `).all(params);
}

// 全量列表 (含历史/被覆盖的块, 用于追溯"以前什么样")
export function listChunks(db, { entityType, entityId, includeHistory = false }) {
  if (includeHistory) {
    return db.prepare(`
      SELECT c.* FROM attribute_chunks c
      WHERE c.entity_type = ? AND c.entity_id = ?
      ORDER BY c.id
    `).all(entityType, entityId);
  }
  return currentChunks(db, { entityType, entityId });
}

export function softDeleteChunk(db, id) {
  const info = db.prepare(
    'UPDATE attribute_chunks SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1'
  ).run(now(), id);
  return info.changes > 0;
}

// 输出口径: 剥离 embedding BLOB (512+ 字节, 只在库内/算分时用, 不出 API)
export function stripEmbedding(row) {
  if (!row) return row;
  const { embedding, ...rest } = row;
  return { ...rest, hasEmbedding: embedding != null };
}

// 暴力余弦召回: 全量加载当前生效且有向量的块, 内存算分
// (量级 <10k 时毫秒级; 超量再切 sqlite-vec, 接口不变)
export function searchChunksByVector(db, { queryVec, chatId = null, topK = RETRIEVAL_FALLBACK_DEFAULTS.topK, minScore = 0 }) {
  const rows = currentChunks(db, { chatId });
  const scored = [];
  for (const r of rows) {
    const vec = unpackVector(r.embedding);
    if (!vec || vec.length !== queryVec.length) continue;
    const sim = cosine(queryVec, vec);
    if (sim >= minScore) scored.push({ ...r, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}
