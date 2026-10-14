// 轮次水位提示 (nudge): 让"每轮编织"自己纠偏, 不依赖模型自觉记住纪律。
//
// 为什么需要它 (实测): 连着跑三轮, 模型只在最后织了一次 —— 内容没漏 (窗口滑动覆盖了整场戏),
// 但纪律说的"每轮"没做到。纯靠 AIRP.md 的文字纪律会漂, 而 dsh 侧的 turn-end 钩子
// 需要摸清它的插件 API (另一条路)。
//
// 这里用的是**适配器自己看得到的东西**: 每次 memory_context 调用就是"模型开始了一轮"。
// 于是适配器维护一个 per-chat 计数: 离上次 memory_observe 过了几轮;
// 超过阈值就把一行提示**附在 memory_context 的返回里** —— 模型每次读记忆都会看到,
// 不需要它主动记得"我该编织了"。
//
// 这是确定性纠正, 不是新语义: 阈值与文案只在 constants 里定义一次 (与语义同源同规)。
import { MCP_NUDGE } from '../src/domain/constants.js';

const state = new Map();   // chatId -> 自上次 observe 以来的 context 调用次数

/** 每次 memory_context 调用记一笔, 返回是否该提示 (以及提示文案) */
export function noteContextCall(chatId) {
  const key = String(chatId ?? '');
  const n = (state.get(key) ?? 0) + 1;
  state.set(key, n);
  if (n < MCP_NUDGE.afterContextCalls) return null;
  return MCP_NUDGE.hint.replace('{n}', String(n));
}

/** memory_observe 调用后清零水位 */
export function noteObserve(chatId) {
  state.set(String(chatId ?? ''), 0);
}

/**
 * observe 全层失败时的醒目提示 —— 成功记了就返回 null。
 *
 * 关键: 这时**不要清零水位**。全层失败=一行没写, 却清零就等于把"该补织"这件事抹掉了;
 * 留着水位, 下一轮读记忆时【记忆编织提醒】会自然再提一次, 模型自己补跑就完事。
 * @param {object} data /api/observe 的返回体
 */
export function observeFailureHint(data) {
  if (!data?.allFailed) return null;
  const steps = Array.isArray(data.failedSteps) && data.failedSteps.length
    ? data.failedSteps.join(' / ') : '全部';
  const first = data.failedSteps?.map((id) => data.steps?.[id]?.error).find(Boolean)
    ?? data.mergedError ?? '未知错误';
  // 取一行 + 在第一个 '<' 处截断: 网关的错误页是整篇 HTML (实测 502 就是),
  // 塞进模型上下文既没用又吃 token, 只留状态码那一句就够。
  const oneLine = String(first).split('\n')[0].split('<')[0].replace(/[:\s]+$/, '').trim().slice(0, 160);
  return MCP_NUDGE.failedHint
    .replace('{steps}', steps)
    .replace('{reason}', oneLine || '未知错误');
}

/** 只读地看当前水位 (测试与诊断用) */
export function levelOf(chatId) {
  return state.get(String(chatId ?? '')) ?? 0;
}

/** 测试用: 清空全部状态 */
export function reset() {
  state.clear();
}
