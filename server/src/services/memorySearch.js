// 记忆检索: FTS 召回 + 向量召回 + 统一打分
//
// 单独成文件的原因: 注入段注册表 (injectionSections.js) 需要调用这两个召回,
// 而占位编排器 (retrievalService.js) 又依赖注册表 —— 把召回放在这里, 两边都只依赖它,
// 不出现"注册表 ⇄ 编排器"的循环。
// 打分权重/半衰期口径统一来自 domain/constants.js (与 GET /api/meta 同源)。
import { now, buildFtsQuery } from '../utils/text.js';
import { RETRIEVAL_SCORING, RETRIEVAL_FALLBACK_DEFAULTS, SUMMARY_MEMORY_TYPE } from '../domain/constants.js';
import { searchChunksByVector, stripEmbedding } from './chunkService.js';

const W_RELEVANCE = RETRIEVAL_SCORING.weights.relevance;
const W_IMPORTANCE = RETRIEVAL_SCORING.weights.importance;
const W_RECENCY = RETRIEVAL_SCORING.weights.recency;
const RECENCY_HALF_LIFE_DAYS = RETRIEVAL_SCORING.recencyHalfLifeDays;

export const VISIBILITY = `(
  m.scope = 'global'
  OR (m.scope = 'character' AND m.character_id = @characterId)
  OR (m.scope = 'chat' AND m.chat_id = @chatId)
)`;

function recencyScore(tsSeconds) {
  if (!tsSeconds) return 0;
  const ageDays = (now() - tsSeconds) / 86400;
  return Math.exp((-ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
}

export function searchMemories(db, {
  query, chatId = null, characterId = null,
  topK = RETRIEVAL_FALLBACK_DEFAULTS.topK,
  excludeTypes = null,
}) {
  const match = buildFtsQuery(query);
  if (!match) return { hits: [], match: null };

  // 注入时排除摘要: 摘要由【前情提要】常驻, 若仍参与 FTS 打分只会重复占位,
  // 并把它自己的 token 花在"再次出现"上。
  const excluded = Array.isArray(excludeTypes)
    ? excludeTypes.filter((t) => typeof t === 'string' && t)
    : [];
  const typeClause = excluded.length
    ? `AND m.type NOT IN (${excluded.map((_, i) => `@ex${i}`).join(', ')})`
    : '';
  const params = { match, characterId, chatId };
  excluded.forEach((t, i) => { params[`ex${i}`] = t; });

  // bm25(虚表, 列权重...): content 权重 1.0, keywords 权重 2.0; 返回值越小越相关
  const rows = db.prepare(`
    SELECT m.*, bm25(memories_fts, 1.0, 2.0) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH @match
      AND m.is_active = 1
      ${typeClause}
      AND ${VISIBILITY}
  `).all(params);

  if (rows.length === 0) return { hits: [], match };

  const maxRel = Math.max(...rows.map((r) => -r.rank), 1e-9);
  const hits = rows
    .map((r) => {
      const relevance = -r.rank / maxRel;
      const score =
        W_RELEVANCE * relevance +
        W_IMPORTANCE * r.importance +
        W_RECENCY * recencyScore(r.last_accessed_at ?? r.created_at);
      return { ...r, tags: undefined, relevance, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  touchAccess(db, hits.map((h) => h.id));
  writeRetrievalLog(db, { query, chatId, hits });
  return { hits, match };
}

function touchAccess(db, ids) {
  if (!ids.length) return;
  const ts = now();
  const stmt = db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?');
  db.transaction(() => { for (const id of ids) stmt.run(ts, id); })();
}

// 检索日志只保留最近 N 行 (内部诊断用, 不是跨端语义, 故阈值留在本文件):
// 每次写入顺带裁剪, 防长用无界增长。裁剪是单条 DELETE, 代价可忽略。
const RETAIN_LOG_ROWS = 10000;

function writeRetrievalLog(db, { query, chatId, hits }) {
  const scores = {};
  for (const h of hits) scores[h.id] = Number(h.score.toFixed(4));
  db.prepare(`
    INSERT INTO retrieval_log (query, chat_id, hit_memory_ids, scores, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(query, chatId, JSON.stringify(hits.map((h) => h.id)), JSON.stringify(scores), now());
  db.prepare(`
    DELETE FROM retrieval_log
    WHERE id NOT IN (SELECT id FROM retrieval_log ORDER BY id DESC LIMIT ${RETAIN_LOG_ROWS})
  `).run();
}

// 向量召回: 三阶观察块, 与 FTS 同框架打分 (余弦即相关性)
export async function searchChunks(db, embed, { query, chatId = null, topK = RETRIEVAL_FALLBACK_DEFAULTS.topK }) {
  if (!query || !embed) return { hits: [] };
  const [queryVec] = await embed.embed([query]);
  const rows = searchChunksByVector(db, { queryVec, chatId, topK });
  const maxRel = Math.max(...rows.map((r) => r.similarity), 1e-9);
  const hits = rows.map((r) => {
    const relevance = r.similarity / maxRel;
    const score =
      W_RELEVANCE * relevance +
      W_IMPORTANCE * r.importance +
      W_RECENCY * recencyScore(r.created_at);
    return { ...stripEmbedding(r), relevance, score };
  }).sort((a, b) => b.score - a.score);
  return { hits };
}

export { SUMMARY_MEMORY_TYPE };
