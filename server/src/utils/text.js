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

/**
 * 槽位取值的规范化指纹 —— 用来判定"这是同一个值的重述" (V8, docs/verb-layer.md §16.10)。
 *
 * 步骤: NFKC 归一 (全角→半角, 兼容字符统一) → 转小写 → 只保留字母/数字/汉字。
 * 于是"仅标点差异""仅空白差异""全角半角差异"都归为同一条; 措辞一变指纹就变。
 *
 * 为什么不用 embedding 相似度: 实测 mock embedding 下"仅标点差异"=0.85、
 * "末尾加一句"=0.81, 与真正的更新同区间 —— 阈值分不开"换个标点"和"改了内容"。
 * 规范化判等是确定性的: 同样输入永远同样输出, 可复现、可审计、无模型依赖。
 *
 * 注意它是**指纹不是文本**: 只用于判等与去重, 任何地方输出给 LLM 或用户时都用原文。
 */
export function normalizeSlotValue(text) {
  if (text == null) return '';
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
