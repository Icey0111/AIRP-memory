// 文本工具: FTS 查询构造 / token 估算 / 时间

export function now() {
  return Math.floor(Date.now() / 1000);
}

// 把用户查询转成 FTS5 MATCH 表达式:
//   按空白切词 -> 清洗特殊字符 -> 每个词加引号 -> OR 连接
// unicode61 对中文按连续 CJK 整段成词, 因此查询整段也能命中子串
export function buildFtsQuery(query, maxTerms = 8) {
  if (!query || typeof query !== 'string') return null;
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .slice(0, maxTerms);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

// 粗略 token 估算: 中文约 1~1.5 字/token, 英文约 4 字符/token, 取保守值
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 2);
}

export function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
