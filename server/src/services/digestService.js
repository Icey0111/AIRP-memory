// 【前情提要】组装: 把本聊天已生成的摘要按楼层顺序拼成一条常驻段落
//
// 为什么独立成段、不走相似度检索 (本模块存在的全部理由):
//   摘要覆盖的正文已被 /hide 移出 prompt, 摘要是那段剧情唯一的载体。
//   若摘要仍按 FTS 取 top-k, 当前轮关键词不命中就整条不进 prompt,
//   被隐藏的区间在模型眼里就成了空洞 —— 而且系统性偏向漏: 摘要长、关键词稀疏,
//   在 bm25 里天然吃亏, 而相关性占打分权重的 0.6。
//   所以摘要改为"必然在场"的独立段落, 只受自己的 token 预算约束。
//
// 预算不足时的取舍: 保新丢旧。与可见窗口相接的最近摘要最关键 (决定"刚才发生了什么");
// 早期剧情里的稳定设定通常已沉淀到角色画像与 fact 记忆, 丢最早一条不会让它们消失。
import { estimateTokens } from '../utils/text.js';
import { formatStamp } from '../utils/time.js';
import { DIGEST_FORMAT, SUMMARY_POLICY, SUMMARY_MEMORY_TYPE } from '../domain/constants.js';

/** 取本聊天全部生效摘要, 按写入顺序排列 (= 楼层先后, 因为总结只向前推进) */
export function listChatSummaries(db, chatId) {
  if (!chatId) return [];
  const rows = db.prepare(`
    SELECT id, content, source_message_ids, in_world_time, created_at
    FROM memories
    WHERE type = @type
      AND is_active = 1
      AND scope = 'chat'
      AND chat_id = @chatId
    ORDER BY id ASC
  `).all({ type: SUMMARY_MEMORY_TYPE, chatId });
  return rows.map((r) => ({ ...r, range: floorRange(r.source_message_ids) }));
}

/**
 * 从 source_message_ids 里取最小/最大楼层号; 解析不出返回 null。
 *
 * ⚠️ 两种历史写法都要认: 纯数字 `"12"` 与带前缀的楼层标签 `"floor-12"`。
 * 旧版扩展写的是后者, 而这里曾经只 `Number(x)` —— 结果 `["floor-2","floor-3"]` 全部非整数,
 * 区间判定恒为 null, **【前情提要】的 `[起-止]` 在真实数据上一直是静默缺失的**
 * (digest.smoke 的夹层用的是纯数字, 所以测试全绿, 只有真库能暴露)。
 */
function floorRange(raw) {
  let ids;
  try {
    ids = JSON.parse(raw ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(ids)) return null;
  const nums = ids
    .map((x) => {
      const m = /(\d+)\s*$/.exec(String(x));
      return m ? Number(m[1]) : Number.NaN;
    })
    .filter((n) => Number.isInteger(n));
  if (!nums.length) return null;
  return { from: Math.min(...nums), to: Math.max(...nums) };
}

/** 按 DIGEST_FORMAT 渲染一行。
 *  V10 严格时间口径: 行首的 {time} 是**精确时间戳** (`2026年10月14日星期三 21:28`),
 *  取自该条摘要的写入时间; 剧情内标签不进 prompt —— "第三夜"是多久以前, 模型答不出。 */
function formatLine(row) {
  const time = formatStamp(row.created_at);
  if (!row.range) return `[${time}] ${row.content}`;
  return DIGEST_FORMAT.line
    .replace('{time}', time)
    .replace('{from}', String(row.range.from))
    .replace('{to}', String(row.range.to))
    .replace('{content}', row.content);
}

/** 有效预算: 调用方给的正数优先 (钳制在策略区间内), 否则用策略默认值 */
export function resolveDigestTokens(override) {
  const { maxTokens: fallback, limits } = SUMMARY_POLICY.digest;
  const n = Number(override);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  const lo = Number.isFinite(Number(limits?.min)) && Number(limits.min) > 0 ? Number(limits.min) : 1;
  const hi = Number.isFinite(Number(limits?.max)) && Number(limits.max) > 0 ? Number(limits.max) : base;
  return Math.min(Math.max(base, lo), hi);
}

/**
 * 组装【前情提要】段。
 *
 * @param {object} db
 * @param {{chatId?:string|null, maxTokens?:number|null}} [opts]
 * @returns {{
 *   text:string, tokens:number, count:number, total:number,
 *   droppedCount:number, truncated:boolean, ids:number[],
 *   fromFloor:number|null, toFloor:number|null, maxTokens:number
 * }}
 */
export function buildDigest(db, { chatId = null, maxTokens = null } = {}) {
  const cap = resolveDigestTokens(maxTokens);
  const rows = listChatSummaries(db, chatId);

  if (!rows.length) {
    return {
      text: '', tokens: 0, count: 0, total: 0,
      droppedCount: 0, truncated: false, ids: [],
      fromFloor: null, toFloor: null, maxTokens: cap,
    };
  }

  const kept = [];
  let used = estimateTokens(DIGEST_FORMAT.header);
  // 从最新往回填: 与可见窗口相接的最近摘要优先级最高
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = formatLine(rows[i]);
    const cost = estimateTokens(`\n${line}`);
    // 至少保留最新一条 —— 只要有摘要, 前情提要就不会是空的
    if (kept.length > 0 && used + cost > cap) break;
    used += cost;
    kept.push({ row: rows[i], line });
  }
  kept.reverse();

  const text = [DIGEST_FORMAT.header, ...kept.map((k) => k.line)].join('\n');
  return {
    text,
    tokens: estimateTokens(text),
    count: kept.length,
    total: rows.length,
    droppedCount: rows.length - kept.length,
    truncated: kept.length < rows.length,
    ids: kept.map((k) => k.row.id),
    fromFloor: kept[0]?.row.range?.from ?? null,
    toFloor: kept[kept.length - 1]?.row.range?.to ?? null,
    maxTokens: cap,
  };
}
