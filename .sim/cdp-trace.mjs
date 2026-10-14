// 事件链追踪: hook eventSource.emit + fetch, 补一条角色楼层, 收集 25s 内的全部痕迹
const base = 'http://127.0.0.1:9222';
const targets = await (await fetch(`${base}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
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

async function evalJs(expr) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval error');
  return result.result.value;
}

// 1. 安装 hooks (幂等)
await evalJs(`
  const m = await import('/script.js');
  if (!window.__tmTrace) {
    window.__tmTrace = [];
    const origEmit = m.eventSource.emit.bind(m.eventSource);
    m.eventSource.emit = function (type, ...args) {
      window.__tmTrace.push('EMIT ' + String(type));
      return origEmit(type, ...args);
    };
    const origOn = m.eventSource.on.bind(m.eventSource);
    m.eventSource.on = function (type, fn) {
      window.__tmTrace.push('ON ' + String(type));
      return origOn(type, fn);
    };
    const of = window.fetch.bind(window);
    window.fetch = (...a) => {
      const u = String(a[0]);
      if (u.includes('7780')) window.__tmTrace.push('FETCH ' + (a[1]?.method ?? 'GET') + ' ' + u);
      return of(...a);
    };
  }
  'hooks-ok'
`);

// 2. 补一条角色楼层 (真实事件链)
await evalJs(`
  const m = await import('/script.js');
  const cm = { name: m.characters?.[m.this_chid]?.name ?? 'Seraphina', is_user: false, is_system: false,
    send_date: new Date().toISOString(), mes: '夜色渐深, 你守在树屋窗边, 听见远处狼嚎一声近过一声。', swipes: [], extra: {} };
  m.chat.push(cm);
  try { m.addOneMessage(cm); } catch (e) { window.__tmTrace.push('ADD-ERR ' + e.message); }
  await m.saveChat({ force: true });
  'floor-added len=' + m.chat.length
`);

// 3. 等 25s 收痕迹
await new Promise(r => setTimeout(r, 25000));
const trace = await evalJs(`return (window.__tmTrace ?? []).slice(-60)`);
console.log(JSON.stringify(trace, null, 1));
ws.close();
process.exit(0);
