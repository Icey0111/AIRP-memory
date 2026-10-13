// 长对话压缩: 一段剧情文本 -> 一条摘要记忆 (type='summary')
//
// 与六要素抽取的分工 (互补, 不重复):
//   抽取器留下"骨架" —— 谁/何时/何地/因果边;
//   摘要留下"叙事连续性" —— 关系怎么变的、做了什么决定、还有什么悬着没解决。
// 所以摘要 prompt 明确要求不要罗列事件细节, 而保留会影响后续扮演的软信息。
//
// 触发时机由前端掌握 (未总结区间的楼层数达阈值), 阈值本身来自 domain/constants.js,
// 本服务只负责"给一段文本, 还一条摘要", 不关心何时被调用。
import { createMemory, listMemories } from './memoryService.js';
import { parseJsonLoose } from './extractionService.js';
import { SUMMARY_POLICY } from '../domain/constants.js';

/** 摘要长度上限: 允许调用方覆盖, 但不超过策略上限 */
function resolveMaxChars(maxChars) {
  const n = Number(maxChars);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.trunc(n), SUMMARY_POLICY.maxSummaryChars);
  return SUMMARY_POLICY.maxSummaryChars;
}

function buildSystemPrompt(maxChars) {
  return `你是长对话的剧情压缩器。把给定的一段角色扮演对话压缩成一份可长期携带的剧情摘要。
严格输出 JSON, 不要输出任何其他文字:
{
  "summary": "摘要正文, 一段连贯叙述, 不要分点, 不要小标题",
  "keywords": "用于检索的关键词, 空格分隔: 人名 地点 物品 事件名",
  "key_points": ["关键点(短句)", "关键点(短句)"]
}

必须保留:
- 影响后续扮演的人物细节: 性格表现、说话方式、外貌变化、习惯
- 关系与立场的实质变化, 以及促成变化的原因 (例如由戒备转为信任)
- 已经做出的承诺、约定、威胁、交换
- 悬而未决的线索、伏笔、待办之事
- 关键决定及其直接后果

必须丢弃:
- 纯动作与环境描写 (谁看了谁一眼、雨声、光线、站位)
- 无信息量的寒暄与重复对话
- 已经写进上文摘要的内容 (若本次输入里包含既有摘要, 不要重复)

规则:
- 第三人称、过去时叙述; 人物用对话中的主称呼
- 按时间顺序, 允许合并同类小事
- 不编造原文没有的信息
- summary 正文控制在 ${maxChars} 字以内, 宁短勿长
- 没有内容的字段给空字符串 / 空数组`;
}

/**
 * 把一段对话压缩成摘要记忆。
 * @param {object} db
 * @param {{chat:(p:{system:string,user:string})=>Promise<string>}} llm
 * @param {object} input
 * @param {string} input.chatId
 * @param {string} input.text 待压缩的对话原文
 * @param {string[]} [input.sourceMessageIds] 覆盖的楼层号 (供溯源与去重)
 * @param {string} [input.characterId]
 * @param {string|null} [input.inWorldTime] 剧情内时间标签
 * @param {string} [input.keywords] 调用方补充的关键词 (与模型产出合并)
 * @param {number} [input.importance]
 * @param {number} [input.maxChars]
 * @param {boolean} [input.dedupe] 相同楼层集合已有摘要时直接复用 (默认 true)
 */
export async function summarizeConversation(db, llm, {
  chatId, text, sourceMessageIds = [], characterId = null,
  inWorldTime = null, keywords = '', importance = null,
  maxChars = null, dedupe = true,
} = {}) {
  if (!chatId) throw new Error('chatId 必填');
  if (!text || !text.trim()) throw new Error('text 不能为空');

  const ids = sourceMessageIds.map(String);
  const limit = resolveMaxChars(maxChars);
  // 注意 Number(null) === 0: 不能直接 Number.isFinite(Number(importance)),
  // 否则"未传 importance"会被当成显式的 0 存进库
  const impNum = (importance === null || importance === undefined || importance === '')
    ? NaN
    : Number(importance);
  const imp = Number.isFinite(impNum) ? impNum : SUMMARY_POLICY.defaultImportance;

  // 去重: 同一聊天里, 覆盖楼层完全相同的既有摘要直接复用。
  // (手工连点两次"立即总结"不该产生两条一样的摘要; 楼层集合变了才另起一条)
  if (dedupe && ids.length) {
    const existing = findSameCoverage(db, { chatId, ids });
    if (existing) {
      return {
        ok: true,
        deduped: true,
        memoryId: existing.id,
        memory: shape(existing),
        coveredMessageIds: ids,
        keyPoints: [],
        truncated: false,
        inputChars: text.length,
      };
    }
  }

  const raw = await llm.chat({ system: buildSystemPrompt(limit), user: text });
  const data = parseJsonLoose(raw);

  let body = String(data.summary ?? '').trim();
  if (!body) throw new Error('LLM 未返回 summary 正文');
  const truncated = body.length > limit;
  if (truncated) body = `${body.slice(0, limit)}…`;

  const modelKeywords = String(data.keywords ?? '').trim();
  const merged = [keywords, modelKeywords].map((s) => s.trim()).filter(Boolean).join(' ');

  const memory = createMemory(db, {
    type: 'summary',
    content: body,
    keywords: merged,
    scope: 'chat',
    chatId,
    importance: imp,
    sourceMessageIds: ids,
    inWorldTime,
    tags: ['summary'],
  });

  return {
    ok: true,
    deduped: false,
    memoryId: memory.id,
    memory: shape(memory),
    coveredMessageIds: ids,
    keyPoints: Array.isArray(data.key_points) ? data.key_points.filter((x) => x && String(x).trim()).map(String) : [],
    truncated,
    inputChars: text.length,
  };
}

/** 把记忆行裁剪成对外形状 (source_message_ids 解析回数组) */
function shape(memory) {
  let ids = [];
  try { ids = JSON.parse(memory.source_message_ids ?? '[]'); } catch { ids = []; }
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    keywords: memory.keywords ?? '',
    importance: memory.importance,
    scope: memory.scope,
    chatId: memory.chat_id,
    inWorldTime: memory.in_world_time,
    sourceMessageIds: ids,
    tags: memory.tags ?? [],
    createdAt: memory.created_at,
  };
}

/** 在既有摘要里找覆盖楼层集合完全相同的一条 */
function findSameCoverage(db, { chatId, ids }) {
  const want = [...ids].sort().join(',');
  // 只看最近的一批摘要, 避免长聊天把全表扫一遍
  const rows = listMemories(db, { chatId, type: 'summary', limit: 50 });
  for (const row of rows) {
    let got = [];
    try { got = JSON.parse(row.source_message_ids ?? '[]'); } catch { got = []; }
    if ([...got.map(String)].sort().join(',') === want) {
      return { ...row, tags: ['summary'] };
    }
  }
  return null;
}
