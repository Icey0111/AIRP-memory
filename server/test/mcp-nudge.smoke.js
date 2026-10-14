// 轮次水位提示 (nudge) 冒烟测试 —— 钉住"每轮编织"的自我纠偏行为。
// 为什么需要: 纯文字纪律会被模型漂掉 (实测连跑三轮只织了一次)。这里验证:
//   1) 不到阈值不打扰; 2) 到阈值才提示, 且提示带上了轮数;
//   3) memory_observe 之后水位清零, 提示随之消失。
// 运行: node test/mcp-nudge.smoke.js
import { noteContextCall, noteObserve, observeFailureHint, levelOf, reset } from '../mcp/turnNudge.mjs';
import { MCP_NUDGE } from '../src/domain/constants.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

reset();
const CHAT = 'chat-nudge';
console.log(`阈值 = 每 ${MCP_NUDGE.afterContextCalls} 次 memory_context 提示一次`);

// 语义: 第 1 次读记忆是"刚开一轮", 没有可织的东西 → 不提示;
//       第 2 次读记忆说明"上一轮过去了还没织" → 提示。
check('第 1 次读记忆: 不提示 (尚无可织的上一轮)', noteContextCall(CHAT) === null && levelOf(CHAT) === 1);
const hint = noteContextCall(CHAT);
check(`第 ${MCP_NUDGE.afterContextCalls} 次读记忆: 给出提示`, typeof hint === 'string' && hint.length > 10, String(hint));
check('提示里带上积压轮数 (模型能判断落后多久)',
  hint.includes(String(MCP_NUDGE.afterContextCalls)) && !hint.includes('{n}'), hint);
check('提示指向具体动作 (调 memory_observe 织一次)',
  hint.includes('memory_observe') && hint.includes('记忆网络'));

noteObserve(CHAT);
check('织过之后水位清零', levelOf(CHAT) === 0);
check('清零后不再提示', noteContextCall(CHAT) === null && levelOf(CHAT) === 1);

check('不同会话各自计数 (不会互相影响)', levelOf('other-chat') === 0);
noteContextCall('other-chat');
check('另一个会话独立计数', levelOf('other-chat') === 1 && levelOf(CHAT) === 1);

// ---- 全层失败 (一行没落库) 的显式提示 ----
// 实测事故: 抽取网关整段 502, 三层全灭, 但顶层 ok 仍是 true (单层失败不中断其余层是设计),
// 模型见 ok:true 就往下走 → 这一轮剧情永久丢失且无人察觉。这里钉住"全局失败必须说出来"。
console.log('\n-- observe 全层失败 --');
check('正常返回不提示', observeFailureHint({ allFailed: false, failedSteps: [] }) === null);
check('部分失败也不提示 (有层落库了)', observeFailureHint({ allFailed: false, failedSteps: ['stances'] }) === null);
const failHint = observeFailureHint({
  allFailed: true,
  failedSteps: ['instances', 'attributes', 'stances'],
  // 真实 502 的错误文本就是整篇 HTML 错误页 (多行)
  steps: {
    instances: { ok: false, error: 'LLM 请求失败 502: <!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->' },
    attributes: { ok: false, error: 'LLM 请求失败 502: ...' },
    stances: { ok: false, error: 'LLM 请求失败 502: ...' },
  },
});
check('全层失败给出提示', typeof failHint === 'string' && failHint.length > 20, String(failHint));
check('提示说明"一行都没写进记忆网络"', failHint.includes('一行都没写进记忆网络'), failHint);
check('提示带上失败层名', failHint.includes('instances / attributes / stances'), failHint);
check('提示带上首个错误原因 (只留状态码那行, HTML 错误页不进上下文)',
  failHint.includes('502') && !failHint.includes('<') && failHint.length < 400, failHint);
check('提示给出补跑动作与关键约束 (相同 text/sourceMessageIds)',
  failHint.includes('memory_observe') && failHint.includes('sourceMessageIds'));
check('占位符全部被替换', !failHint.includes('{steps}') && !failHint.includes('{reason}'), failHint);

// 关键不变量: 全层失败**不清水位** —— 否则"该补织"这件事被抹掉, 下一轮不再提醒
reset();
noteContextCall(CHAT);
noteContextCall(CHAT);
check('失败前水位已到提示线', levelOf(CHAT) >= MCP_NUDGE.afterContextCalls);
// 适配器只在没有失败提示时才 noteObserve: 这里模拟真实接线
if (!failHint) noteObserve(CHAT);
check('失败后水位不清零 (下一轮读记忆会再提醒补跑)', levelOf(CHAT) === 2, String(levelOf(CHAT)));
const again = noteContextCall(CHAT);
check('因此下一轮读记忆仍然提示补织', typeof again === 'string', String(again));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
