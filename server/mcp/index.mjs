// AIRP 记忆服务的 MCP stdio 适配器 (零依赖, NDJSON JSON-RPC)。
// 职责单一: 把 MCP tools/list、tools/call 转发到 127.0.0.1:7780 的现有 HTTP API。
// 不含任何记忆语义 —— 语义在 server/src/domain/constants.js, 工具描述从它派生。
//
// 运行: node mcp/index.mjs  (环境变量 AIRP_SERVER_URL 可覆盖上游地址)
import readline from 'node:readline';
import { TOOLS } from './tools.mjs';
import { noteContextCall, noteObserve, observeFailureHint } from './turnNudge.mjs';

const UPSTREAM = (process.env.AIRP_SERVER_URL ?? 'http://127.0.0.1:7780').replace(/\/$/, '');
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'airp-memory', version: '0.1.0' };

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callHttp(tool, args = {}) {
  const { method, path } = tool.http;
  let url = UPSTREAM + path;
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    if ([...qs].length) url += `?${qs}`;
  } else {
    init.body = JSON.stringify(args);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知类消息不应答

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'AIRP 长期记忆系统。纪律: 回复用户前先调 memory_context 取注入文本; '
          + '有新剧情文本后调 memory_observe 一次跑完三段抽取(事件要素/属性观察/关系立场); '
          + '会话结束或剧情告一段落时调 memory_summarize 沉淀; '
          + '枚举/默认值/能力状态一律以 memory_meta 为准, 不要猜。',
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = toolByName.get(params?.name);
      if (!tool) return replyError(id, -32602, `未知工具: ${params?.name}`);
      try {
        const { status, data } = await callHttp(tool, params.arguments ?? {});
        const isError = status >= 400 || data?.ok === false;
        let text = JSON.stringify(data, null, 2);

        // 轮次水位提示: 把"该编织了"贴在模型每次读记忆的返回值里 ——
        // 不依赖它自己记得纪律 (实测会漂), 也不依赖 dsh 的 turn-end 钩子。
        if (!isError) {
          if (tool.name === 'memory_observe') {
            // 全层失败 = 一行没落库: 贴醒目提示, 且**不清水位** (下一轮读记忆时自然会再提醒补跑)
            const failHint = observeFailureHint(data);
            if (failHint) text += failHint;
            else noteObserve(params.arguments?.chatId);
          }
          if (tool.name === 'memory_context') {
            const hint = noteContextCall(params.arguments?.chatId);
            if (hint) text += hint;
          }
        }
        return reply(id, {
          content: [{ type: 'text', text }],
          isError,
        });
      } catch (err) {
        return reply(id, {
          content: [{
            type: 'text',
            text: `记忆服务不可达 (${UPSTREAM}): ${err.message}。请先启动 server (npm start)。`,
          }],
          isError: true,
        });
      }
    }
    default:
      return replyError(id, -32601, `不支持的方法: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  handle(msg).catch((err) => {
    if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, err.message);
  });
});
