// 三阶属性观察块: 写入 / 当前生效口径 / 暴力余弦召回
// 防吃书口径与立场层一致: is_active + 未被 supersede + 未过生效区间
import { now, clamp01 } from '../utils/text.js';
import { CHUNK_DEFAULTS, RETRIEVAL_FALLBACK_DEFAULTS } from '../domain/constants.js';
import { packVector, unpackVector, cosine } from './embeddingClient.js';
import { findOrCreateValue } from './valueService.js';

// 当前生效过滤 (SQL 片段): 未删除 + 未过期 + 未被新版本覆盖
const CURRENT = `
  c.is_active = 1
  AND c.valid_to_event_id IS NULL
  AND c.id NOT IN (SELECT supersedes_chunk_id FROM attribute_chunks WHERE supersedes_chunk_id IS NOT NULL)
`;

export function addChunk(db, {
  entityType, entityId, aspect, content,
  embeddingVec = null, embeddingModel = null,
  validFromEventId = null, validToEventId = null, supersedesChunkId = null,
  memoryId = null, sourceMessageIds = [], chatId = null, importance = CHUNK_DEFAULTS.importance,
}) {
  if (!entityType || !entityId) throw new Error('entityType/entityId 必填');
  if (!aspect || !content) throw new Error('aspect/content 必填');
  // V7: 维度名也是网络里的取值元素 (元素先于指针, §16.4) —— 注册但不改文本列
  findOrCreateValue(db, { name: aspect, kind: 'aspect' });
  const ts = now();
  const info = db.prepare(`
    INSERT INTO attribute_chunks
      (entity_type, entity_id, aspect, content, embedding, embedding_model,
       valid_from_event_id, valid_to_event_id, supersedes_chunk_id,
       memory_id, source_message_ids, chat_id, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityType, entityId, aspect, content,
    embeddingVec ? packVector(embeddingVec) : null, embeddingModel,
    validFromEventId, validToEventId, supersedesChunkId,
    memoryId, JSON.stringify(sourceMessageIds), chatId, clamp01(importance), ts, ts,
  );
  return Number(info.lastInsertRowid);
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
