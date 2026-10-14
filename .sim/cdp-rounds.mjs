// 真实生成轮次: /send continue + /trigger, 等真实 AI 回复落地, 每轮后报告触发状态
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.exception?.description ?? JSON.stringify(result.exceptionDetails).slice(0, 200));
  return result.result.value;
}

const ROUNDS = Number(process.argv[2] ?? 5);
for (let r = 1; r <= ROUNDS; r++) {
  const st = await evalJs(`
    const m = await import('/script.js');
    const ctx = window.SillyTavern.getContext();
    const before = m.chat.length;
    await ctx.executeSlashCommandsWithOptions('/send continue');
    await ctx.executeSlashCommandsWithOptions('/trigger');
    // 等真实生成: 角色楼层落地且正文达到目标长度 (流式增长, 500-700 字)
    let waited = 0, done = false, lastLen = 0;
    while (waited < 300000) {
      await new Promise(r=>setTimeout(r, 4000)); waited += 4000;
      const last = m.chat[m.chat.length - 1];
      const len = last && !last.is_user ? String(last.mes).length : 0;
      if (m.chat.length >= before + 2 && len >= 300 && len === lastLen) { done = true; break; } // 长度稳定 = 生成完成
      lastLen = len;
    }
    await m.saveChat({ force: true });
    const lastMsg = m.chat[m.chat.length - 1];
    return { round: ${r}, before, after: m.chat.length, done,
             replyChars: lastMsg && !lastMsg.is_user ? String(lastMsg.mes).length : 0,
             lastChar: lastMsg && !lastMsg.is_user ? String(lastMsg.mes).slice(0, 50) : '(无回复)' }
  `);
  console.log(`轮${r}: ${st.before} -> ${st.after} 层 done=${st.done} | AI: ${st.lastChar}`);

  // 查触发状态 (新摘要?)
  const trig = await evalJs(`
    const ctx = window.SillyTavern.getContext();
    return { md: ctx.chatMetadata?.tavernMemory ?? null }`);
  console.log(`  边界: ${JSON.stringify(trig.md)}`);

  const mem = await fetch('http://127.0.0.1:7780/api/memories?chatId=' + encodeURIComponent('Seraphina - chat') + '&type=summary')
    .then(r => r.json());
  console.log(`  摘要: ${mem.memories.length} 条 -> ${mem.memories.map(x => '#' + x.id + '[' + JSON.parse(x.source_message_ids)[0] + '-' + JSON.parse(x.source_message_ids).at(-1) + ']').join(', ')}`);

  if (mem.memories.length >= 2) { console.log('>>> 新一轮总结已自动触发!'); break; }
}
ws.close();
process.exit(0);
