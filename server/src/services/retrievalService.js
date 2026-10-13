// 检索闭环: FTS 召回 + 向量召回(观察块) -> 统一打分 -> top-k -> 注入组装
// 打分权重/半衰期口径统一来自 domain/constants.js (与 GET /api/meta 同源)
import { now, buildFtsQuery, estimateTokens } from '../utils/text.js';
import {
  RETRIEVAL_SCORING, RETRIEVAL_FALLBACK_DEFAULTS, SUMMARY_MEMORY_TYPE,
  INJECTION_TABLES,
} from '../domain/constants.js';
import { getProfile } from './profileService.js';
import {
  createInjectionContext, buildProfileTable, buildStanceTable,
  buildEntityTable, buildTimelineTable, buildRetrievedTable, buildPendingSection,
} from './injectionService.js';
import { resolveEntityName } from './stanceService.js';
import { chatTimeline } from './graphService.js';
import { searchChunksByVector, stripEmbedding } from './chunkService.js';
import { buildDigest } from './digestService.js';

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

// 注入组装: 画像表(常驻) + 立场表(常驻) + 前情提要(摘要链常驻) + 相关记忆(FTS) + 相关细节(向量)
//
// 两种形态 (开关见 INJECTION_TABLES.enabled / 请求体 injectTables):
//   'tables'  —— 常驻段表格化 (对齐纯文本), 检索段行化 (紧凑 markdown)
//   'bullets' —— 原有的平铺 bullet 路径, 无损回退口径
// 表格渲染抛错时自动回退 bullet 并记 warn: 注入永远不断供, 生成本身不受影响。
export async function assembleContext(db, embed, {
  query, chatId = null, characterId = null,
  topK = RETRIEVAL_FALLBACK_DEFAULTS.topK,
  tokenBudget = RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget,
  digestMaxTokens = null,
  injectTables = null,
  injectStances = null,
  injectPending = null,
}) {
  const tablesOn = injectTables === false ? false : INJECTION_TABLES.enabled;
  const stancesOn = tablesOn && injectStances !== false;
  // 一次组装共享一个首现追踪器: 关键实体表先登记速写, 时间线里的同名人不再重复展开 (L3)
  const ctx = createInjectionContext();
  const sections = [];
  let usedTokens = 0;
  let fellBack = false;

  // 0) 立场先取数 (画像表要用它做跨段去重: 态度类条目以立场表为准)
  let stance = null;
  if (stancesOn && chatId) {
    try {
      stance = buildStanceTable(db, { chatId });
    } catch (err) {
      console.warn(`[injection] 立场表渲染失败, 回退 bullet: ${err.message}`);
      fellBack = true;
    }
  }
  const stanceTargets = stance ? stance.targets : [];

  // 1) 生效画像 (常驻, 不参与打分, 独立预算 —— 不占检索预算)
  let profileCount = 0;
  let profileTotal = 0;
  let profileTokens = 0;
  let profileDropped = 0;
  if (characterId) {
    // 三级退化: 表格 -> bullet -> 整段跳过。任何一级失败都不许影响生成本身,
    // 所以回退路径自己也包了 try (回退不是"一定成功", 只是"更简单")。
    if (tablesOn) {
      try {
        const t = buildProfileTable(db, { characterId, dedupeAgainst: stanceTargets });
        profileCount = t.count;
        profileTotal = t.total;
        profileTokens = t.tokens;
        profileDropped = t.dropped;
        if (t.text) sections.push(t.text);
      } catch (err) {
        console.warn(`[injection] 画像表渲染失败, 回退 bullet: ${err.message}`);
        fellBack = true;
        const b = safeProfileBullets(db, characterId);
        profileCount = b.count;
        profileTotal = b.count;
        profileTokens = b.tokens;
        if (b.text) sections.push(b.text);
      }
    } else {
      const b = safeProfileBullets(db, characterId);
      profileCount = b.count;
      profileTotal = b.count;
      profileTokens = b.tokens;
      if (b.text) sections.push(b.text);
    }
  }

  // 2) 关系立场 (常驻, 独立预算) —— 原来 stances 完全不进 prompt, 这是新增内容段
  let stanceCount = 0;
  let stanceTotal = 0;
  let stanceTokens = 0;
  if (stance) {
    stanceCount = stance.count;
    stanceTotal = stance.total;
    stanceTokens = stance.tokens;
    if (stance.text) sections.push(stance.text);
  }

  // 3) 关键实体 (常驻限量, 独立预算) —— 静态空间/人物的"规范描述"住处 (§4.2)
  //    与 4) 一起构成图的节点目录与枢纽邻接视图; 两段有依赖:
  //    实体表先把速写登记进共享追踪器, 时间线里的同名人因此只出现纯名字 (L3 首现展开)。
  const windowEvents = (tablesOn && chatId) ? safeTimelineQuery(db, chatId, () => { fellBack = true; }) : [];
  const windowIds = windowEvents.map((e) => e.id);

  let entityCount = 0; let entityTotal = 0; let entityTokens = 0; let entityDropped = 0;
  let entitySketches = new Map();
  let entityHeadChunkIds = new Set();
  if (tablesOn && chatId) {
    try {
      const t = buildEntityTable(db, { chatId, ctx, windowIds });
      entityCount = t.count;
      entityTotal = t.total;
      entityTokens = t.tokens;
      entityDropped = t.dropped;
      entitySketches = t.sketches;
      entityHeadChunkIds = t.headChunkIds;
      if (t.text) sections.push(t.text);
    } catch (err) {
      console.warn(`[injection] 关键实体表渲染失败, 该段跳过: ${err.message}`);
      fellBack = true;
    }
  }

  // 4) 前情提要 (摘要链, 常驻)
  //    走自己的预算, 不参与打分, 也不占检索预算 —— 否则长对话里摘要会被
  //    "当前更像"的记忆挤掉, 而它覆盖的正文已被隐藏, 那段剧情就彻底没了。
  const digest = buildDigest(db, { chatId, maxTokens: digestMaxTokens });
  if (digest.text) sections.push(digest.text);

  // 5) 事件时间线 (常驻限量, 独立预算) —— 以时间节点为锚的事件邻接视图 (§3.4)
  //    归属声称以来源口吻内联在这里 (已定局的: 已证实 / 已被拆穿); 未决的走 6) 【待兑现】
  let timelineCount = 0; let timelineTotal = 0; let timelineTokens = 0; let timelineDropped = 0;
  let propositionRows = 0;
  if (tablesOn && chatId) {
    try {
      const t = buildTimelineTable(db, { chatId, ctx, sketches: entitySketches, events: windowEvents });
      timelineCount = t.count;
      timelineTotal = t.total;
      timelineTokens = t.tokens;
      timelineDropped = t.dropped;
      propositionRows = (t.events ?? []).slice(0, t.count).filter((e) => e.isProposition).length;
      if (t.text) sections.push(t.text);
    } catch (err) {
      console.warn(`[injection] 事件时间线渲染失败, 该段跳过: ${err.message}`);
      fellBack = true;
    }
  }

  // 6) 【待兑现】(常驻限量, 独立预算) —— 未决命题: 承诺/约定/威胁/悬而未决的线索。
  //    这批信息原先只存在于摘要的自由文本里 (无法核对/标记/统计); 结构化后单独成段,
  //    与时间线不重叠 —— 未决的只看前景, 已定局的才进时间线。
  let pendingCount = 0; let pendingTotal = 0; let pendingTokens = 0; let pendingDropped = 0;
  const pendingOn = injectPending !== false;
  const pending = (chatId && pendingOn)
    ? buildPendingSection(db, { chatId })
    : { text: '', count: 0, total: 0, tokens: 0, dropped: 0 };
  pendingCount = pending.count;
  pendingTotal = pending.total;
  pendingTokens = pending.tokens;
  pendingDropped = pending.dropped;
  if (pending.text) sections.push(pending.text);

  // 6) FTS 召回的相关记忆 (排除摘要: 摘要已由【前情提要】常驻, 再参与召回只会重复占位)
  const { hits } = query
    ? searchMemories(db, { query, chatId, characterId, topK, excludeTypes: [SUMMARY_MEMORY_TYPE] })
    : { hits: [] };

  let hitCount = 0;
  if (hits.length) {
    if (tablesOn) {
      // 检索层行化: 紧凑 markdown 管道行 (不对齐), 与常驻层是两种形态
      const rows = hits.map((h) => ({
        cells: { type: h.type, time: h.in_world_time ?? '', content: h.content, floor: floorOf(h) },
      }));
      const t = buildRetrievedTable({
        header: INJECTION_TABLES.headers.memories,
        columns: [
          { key: 'type', title: '类型' },
          { key: 'time', title: '剧情时间' },
          { key: 'content', title: '内容' },
          { key: 'floor', title: '楼层' },
        ],
      }, rows, tokenBudget - usedTokens);
      hitCount = t.count;
      usedTokens += t.tokens;
      if (t.text) sections.push(t.text);
    } else {
      const memoryLines = [];
      for (const h of hits) {
        const line = `- (${h.type}${h.in_world_time ? `, ${h.in_world_time}` : ''}) ${h.content}`;
        const cost = estimateTokens(line);
        if (usedTokens + cost > tokenBudget) break;
        memoryLines.push(line);
        usedTokens += cost;
      }
      hitCount = memoryLines.length;
      if (memoryLines.length) {
        sections.push(`${INJECTION_TABLES.headers.memories}\n${memoryLines.join('\n')}`);
      }
    }
  }

  // 7) 向量召回的观察块 (模糊语义细节: 性格/外貌/氛围...)
  // embedding 服务是外部网络依赖: 挂了/超时只应丢掉这一段, 绝不能让注入断供 ——
  // 本端点是前端每轮生成前的主入口, 断供 = 角色扮演中断。
  // (与 degrade='silent' 的契约一致: 未配置时静默无此段, 请求失败时同样静默降级,
  //  但如实上报 chunkError 供前端诊断。)
  let chunkHits = [];
  let chunkError = null;
  try {
    ({ hits: chunkHits } = await searchChunks(db, embed, { query, chatId, topK }));
  } catch (err) {
    console.warn(`[injection] 向量召回失败, 跳过相关细节段: ${err.message}`);
    chunkError = err.message;
    fellBack = true;
  }
  // L3 跨段去重: 已由关键实体表的速写覆盖的观察块不重复渲染 —— 按块 id 判定 (精确),
  // 呈现层去重, 数据一字未删 (关掉 injectTables 就回来)
  const newChunkHits = chunkHits.filter((h) => !entityHeadChunkIds.has(h.id));
  const chunkDeduped = chunkHits.length - newChunkHits.length;

  let chunkHitCount = 0;
  if (newChunkHits.length) {
    if (tablesOn) {
      const rows = newChunkHits.map((h) => ({
        cells: {
          entity: resolveEntityName(db, h.entity_type, h.entity_id) ?? '',
          aspect: h.aspect,
          content: h.content,
        },
      }));
      const t = buildRetrievedTable({
        header: INJECTION_TABLES.headers.chunks,
        columns: [
          { key: 'entity', title: '实体' },
          { key: 'aspect', title: '维度' },
          { key: 'content', title: '观察' },
        ],
      }, rows, tokenBudget - usedTokens);
      chunkHitCount = t.count;
      usedTokens += t.tokens;
      if (t.text) sections.push(t.text);
    } else {
      const chunkLines = [];
      for (const h of newChunkHits) {
        const line = `- [${h.aspect}] ${h.content}`;
        const cost = estimateTokens(line);
        if (usedTokens + cost > tokenBudget) break;
        chunkLines.push(line);
        usedTokens += cost;
      }
      chunkHitCount = chunkLines.length;
      if (chunkLines.length) {
        sections.push(`${INJECTION_TABLES.headers.chunks}\n${chunkLines.join('\n')}`);
      }
    }
  }

  return {
    text: sections.join('\n\n'),
    // usedTokens 只表示检索预算 (相关记忆 + 相关细节) 的用量; 常驻段各有独立预算
    usedTokens,
    tokenBudget,
    profileCount,
    profileTotal,
    profileTokens,
    profileDropped,
    stanceCount,
    stanceTotal,
    stanceTokens,
    entityCount,
    entityTotal,
    entityTokens,
    entityDropped,
    timelineCount,
    timelineTotal,
    timelineTokens,
    timelineDropped,
    /** 时间线里带来源口吻的归属声称行数 (已定局: 已证实 / 已被拆穿) */
    propositionRows,
    // 【待兑现】独立预算, 单独上报 (与时间线不重叠)
    pendingCount,
    pendingTotal,
    pendingTokens,
    pendingDropped,
    /** 未决段是否启用 (前端据 meta 与自身偏好关掉时为 false) */
    pendingEnabled: pendingOn,
    tablesEnabled: tablesOn,
    stancesEnabled: stancesOn,
    // tables: 全部表格化 | bullets: 全回退 | mixed: 部分段回退
    injectionMode: !tablesOn ? 'bullets' : (fellBack ? 'mixed' : 'tables'),
    // 前情提要走独立预算, 单独上报, 免得前端把两个预算混在一起显示
    digestCount: digest.count,
    digestTotal: digest.total,
    digestTokens: digest.tokens,
    digestDropped: digest.droppedCount,
    digestTruncated: digest.truncated,
    digestIds: digest.ids,
    digestMaxTokens: digest.maxTokens,
    digestFromFloor: digest.fromFloor,
    digestToFloor: digest.toFloor,
    hitCount,
    hitIds: hits.slice(0, hitCount).map((h) => h.id),
    chunkHitCount,
    chunkHitIds: newChunkHits.slice(0, chunkHitCount).map((h) => h.id),
    // 向量召回失败的原因 (embedding 服务故障); null = 正常 (含未配置/无命中)
    chunkError,
    // 被跨段去重挡下的观察块数量 (它们的内容已由关键实体表呈现, 不重复占 token)
    chunkDeduped,
  };
}

// 时间线取数失败: 记一次降级, 其余段落照常 (时间线的读者只是模型, 不是正确性依赖)
function safeTimelineQuery(db, chatId, onError) {
  try {
    return chatTimeline(db, { chatId });
  } catch (err) {
    console.warn(`[injection] 时间线取数失败: ${err.message}`);
    onError?.();
    return [];
  }
}

function floorOf(memory) {
  try {
    const ids = JSON.parse(memory.source_message_ids ?? '[]');
    return Array.isArray(ids) && ids.length ? String(ids[0]) : '';
  } catch {
    return '';
  }
}

// 回退路径用的 bullet 画像块 (口径与表格化前完全一致)。
// 它自己也可能失败 (例如库读取异常) —— 那时画像段整体跳过, 不影响其余段落与生成。
function safeProfileBullets(db, characterId) {
  try {
    return buildProfileBullets(db, characterId);
  } catch (err) {
    console.warn(`[injection] 画像 bullet 回退同样失败, 该段跳过: ${err.message}`);
    return { text: '', count: 0, tokens: 0 };
  }
}

function buildProfileBullets(db, characterId) {
  const profile = getProfile(db, characterId);
  if (!profile.length) return { text: '', count: 0, tokens: 0 };
  const lines = profile.map((p) => `- [${p.category}] ${p.key}: ${p.value}`);
  const text = `${INJECTION_TABLES.headers.profile}\n${lines.join('\n')}`;
  return { text, count: profile.length, tokens: estimateTokens(text) };
}
