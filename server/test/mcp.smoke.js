// MCP 适配器自检: 协议握手 + 工具清单(语义同源) + 上游不可达时的错误形态。
// 不依赖真实记忆服务 —— 上游不可达用例正好覆盖"服务没起"的降级路径。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'mcp', 'index.mjs')], {
  env: { ...process.env, AIRP_SERVER_URL: 'http://127.0.0.1:1' }, // 故意指向死端口
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`超时: ${method}`)), 5000);
  });
}

// 组合入口上线后, 三段单步抽取不再暴露给模型 (单步端点仍在服务端, 调试用):
// 少两个工具 schema + 少两次往返, 且"同一文本/同一来源"的不变式收回服务端。
const REQUIRED_TOOLS = [
  'memory_context', 'memory_search', 'memory_observe', 'memory_summarize',
  'memory_write', 'memory_write_chunk', 'memory_write_stance',
  'memory_slots', 'memory_list', 'memory_profiles_derive', 'memory_meta',
];

// 1. initialize
const init = await request('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
});
assert.equal(init.result.serverInfo.name, 'airp-memory');
assert.ok(init.result.instructions.includes('memory_context'), 'instructions 应含纪律');

// 2. tools/list: 全量 + 描述非空(来自 ENDPOINTS 摘要) + schema 合法
const list = await request('tools/list', {});
const names = list.result.tools.map((t) => t.name);
for (const name of REQUIRED_TOOLS) assert.ok(names.includes(name), `缺工具 ${name}`);
assert.equal(names.length, REQUIRED_TOOLS.length, '工具数量应与清单一致');
for (const t of list.result.tools) {
  assert.ok(t.description.length >= 6, `${t.name} 描述过短, 疑似契约漂移`);
  assert.equal(t.inputSchema.type, 'object');
}
// 语义同源抽查: memory_write 的 enum 必须来自 constants
const writeTool = list.result.tools.find((t) => t.name === 'memory_write');
assert.ok(writeTool.inputSchema.properties.type.enum.includes('summary'));
assert.ok(writeTool.inputSchema.properties.scope.enum.includes('character'));
// 组合入口的 steps 枚举也必须来自 constants 的管线 (新增步只改 constants)
const observeTool = list.result.tools.find((t) => t.name === 'memory_observe');
assert.deepEqual(observeTool.inputSchema.properties.steps.items.enum, ['instances', 'attributes', 'stances']);
// 三段单步抽取已收进组合入口, 不再暴露给模型 (否则又变成"调用方负责不变式")
for (const gone of ['memory_extract', 'memory_extract_attributes', 'memory_extract_stances']) {
  assert.ok(!names.includes(gone), `${gone} 应已并入 memory_observe`);
}

// 3. tools/call: 上游不可达 → isError + 友好文案 (不抛协议错误)
const call = await request('tools/call', { name: 'memory_meta', arguments: {} });
assert.equal(call.result.isError, true);
assert.ok(call.result.content[0].text.includes('记忆服务不可达'));

// 4. 未知工具 → JSON-RPC 错误
const bad = await request('tools/call', { name: 'nope', arguments: {} });
assert.equal(bad.error.code, -32602);

child.kill();
console.log(`mcp.smoke OK (${REQUIRED_TOOLS.length} 工具, 握手/清单/降级/错误 4 组断言通过)`);
