// CDP Runtime.evaluate 助手: node cdp-eval.mjs "<表达式>"
// 连接 127.0.0.1:9222 第一个 page 目标, awaitPromise + returnByValue
const base = 'http://127.0.0.1:9222';
const expr = process.argv[2];
if (!expr) { console.error('用法: node cdp-eval.mjs "<js 表达式>"'); process.exit(1); }

const targets = await (await fetch(`${base}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('没有 page 目标:', targets.map(t => `${t.type}:${t.url}`)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));

const result = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (result.exceptionDetails) {
  console.error('页面异常:', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails, null, 1));
} else {
  console.log(JSON.stringify(result.result.value, null, 1));
}
ws.close();
process.exit(0);
