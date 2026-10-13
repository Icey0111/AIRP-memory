// 检索闭环: FTS 召回 + 向量召回(观察块) -> 统一打分 -> top-k -> 注入组装
// 打分权重/半衰期口径统一来自 domain/constants.js (与 GET /api/meta 同源)
import { now, buildFtsQuery, estimateTokens } from '../utils/text.js';
import { RETRIEVAL_SCORING, RETRIEVAL_FALLBACK_DEFAULTS } from '../domain/constants.js';
import { getProfile } from './profileService.js';
import { searchChunksByVector, stripEmbedding } from './chunkService.js';

const W_RELEVANCE = RETRIEVAL_SCORING.weights.relevance;
const W_IMPORTANCE = RETRIEVAL_SCORING.weights.importance;
const W_RECENCY = RETRIEVAL_SCORING.weights.recency;
const RECENCY_HALF_LIFE_DAYS = RETRIEVAL_SCORING.recencyHalfLifeDays;

const VISIBILITY = `(
  m.scope = 'global'
  OR (m.scope = 'character' AND m.character_id = @characterId)
  OR (m.scope = 'chat' AND m.chat_id = @chatId)
)`;

function recencyScore(tsSeconds) {
  if (!tsSeconds) return 0;
  const ageDays = (now() - tsSeconds) / 86400;
  return Math.exp((-ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
}

export function searchMemories(db, { query, chatId = null, characterId = null, topK = RETRIEVAL_FALLBACK_DEFAULTS.topK }) {
  const match = buildFtsQuery(query);
  if (!match) return { hits: [], match: null };

  // bm25(虚表, 列权重...): content 权重 1.0, keywords 权重 2.0; 返回值越小越相关
  const rows = db.prepare(`
    SELECT m.*, bm25(memories_fts, 1.0, 2.0) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH @match
      AND m.is_active = 1
      AND ${VISIBILITY}
  `).all({ match, characterId, chatId });

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

function writeRetrievalLog(db, { query, chatId, hits }) {
  const scores = {};
  for (const h of hits) scores[h.id] = Number(h.score.toFixed(4));
  db.prepare(`
    INSERT INTO retrieval_log (query, chat_id, hit_memory_ids, scores, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(query, chatId, JSON.stringify(hits.map((h) => h.id)), JSON.stringify(scores), now());
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

// 注入组装: 画像常驻 + 相关记忆(FTS) + 相关细节(向量观察块), 按 token 预算截断
export async function assembleContext(db, embed, {
  query, chatId = null, characterId = null,
  topK = RETRIEVAL_FALLBACK_DEFAULTS.topK,
  tokenBudget = RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget,
}) {
  const sections = [];
  let usedTokens = 0;

  // 1) 生效画像 (常驻, 不参与打分, 预算外优先保证)
  let profileCount = 0;
  if (characterId) {
    const profile = getProfile(db, characterId);
    profileCount = profile.length;
    if (profile.length) {
      const lines = profile.map((p) => `- [${p.category}] ${p.key}: ${p.value}`);
      const block = `【角色画像】\n${lines.join('\n')}`;
      sections.push(block);
      usedTokens += estimateTokens(block);
    }
  }

  // 2) FTS 召回的相关记忆 (按打分顺序填充, 预算内尽量多装)
  const { hits } = query
    ? searchMemories(db, { query, chatId, characterId, topK })
    : { hits: [] };

  const memoryLines = [];
  for (const h of hits) {
    const line = `- (${h.type}${h.in_world_time ? `, ${h.in_world_time}` : ''}) ${h.content}`;
    const cost = estimateTokens(line);
    if (usedTokens + cost > tokenBudget) break;
    memoryLines.push(line);
    usedTokens += cost;
  }
  if (memoryLines.length) {
    sections.push(`【相关记忆】\n${memoryLines.join('\n')}`);
  }

  // 3) 向量召回的观察块 (模糊语义细节: 性格/外貌/氛围...)
  const { hits: chunkHits } = await searchChunks(db, embed, { query, chatId, topK });
  const chunkLines = [];
  for (const h of chunkHits) {
    const line = `- [${h.aspect}] ${h.content}`;
    const cost = estimateTokens(line);
    if (usedTokens + cost > tokenBudget) break;
    chunkLines.push(line);
    usedTokens += cost;
  }
  if (chunkLines.length) {
    sections.push(`【相关细节】\n${chunkLines.join('\n')}`);
  }

  return {
    text: sections.join('\n\n'),
    usedTokens,
    tokenBudget,
    profileCount,
    hitCount: memoryLines.length,
    hitIds: hits.slice(0, memoryLines.length).map((h) => h.id),
    chunkHitCount: chunkLines.length,
    chunkHitIds: chunkHits.slice(0, chunkLines.length).map((h) => h.id),
  };
}
