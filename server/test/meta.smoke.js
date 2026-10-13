// 契约一致性冒烟测试: GET /api/meta 与 CORS
//
// 这组断言的目的不是"测有没有这个字段", 而是钉死前后端语义一致的机制:
//   1) meta 是唯一语义源 —— 枚举/权重/阈值/默认值必须是服务端真正在用的值, 不是写死的文案
//   2) meta 声明的每个端点必须真实存在 (不是文档里写了但路由没挂)
//   3) meta 声明的能力标记 (needsLlm/needsEmbedding) 必须与实测行为一致
//      —— 声明 needsLlm=false 的端点, 在无 LLM 的服务上绝不能报 LLM 缺失
//   4) CORS 只放行本机来源与显式白名单, 绝不放行任意源
//
// 运行: node test/meta.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createRouter } from '../src/api/routes.js';
import { createCorsMiddleware, describeCors } from '../src/api/cors.js';
import { createMemory } from '../src/services/memoryService.js';
import { addChunk } from '../src/services/chunkService.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { createEmbeddingClient } from '../src/services/embeddingClient.js';
import {
  MEMORY_TYPES, MEMORY_SCOPES, CHUNKABLE_ENTITY_TYPES, THRESHOLDS,
  RETRIEVAL_SCORING, FORGET_SCORING, FORGET_TABLES,
  RETRIEVAL_FALLBACK_DEFAULTS, ENDPOINTS,
} from '../src/domain/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

// ---------- 内存库 + 种子 ----------
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});

createMemory(db, {
  type: 'fact', content: '艾拉是精灵游侠', keywords: 'ELARA',
  scope: 'chat', chatId: 'chat001', importance: 0.5,
});
// person id 1 预置一条生效观察块, 供 profiles-derive 走到真实 LLM 分支
addChunk(db, {
  entityType: 'person', entityId: 1, aspect: 'personality',
  content: '甲很冷静', chatId: 'chat001', importance: 0.5,
});

// ---------- 三套客户端 + 多前缀装配 ----------
const okLlm = createLlmClient({
  provider: 'mock',
  // 必须返回非空 observations, 否则 extractAttributes 会在触达 embedding 之前就返回, 
  // 无法验证"需要 embedding 的端点确实会因 embedding 缺失而失败"
  mockResponse: JSON.stringify({
    observations: [{ entity_type: 'person', entity_name: '甲', aspect: 'x', content: '一条观察' }],
    entries: [],
  }),
});
const okEmbed = createEmbeddingClient({ provider: 'mock', mockDim: 64 });
const unconfLlm = createLlmClient({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' });
const unconfEmbed = createEmbeddingClient({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' });

const corsOptions = { enabled: true, origins: ['http://memory.example.test'] };
const runtime = {
  version: '9.9.9', host: '127.0.0.1', port: 7780, bodyLimit: '2mb',
  cors: describeCors(corsOptions),
};

const app = express();
app.use(createCorsMiddleware(corsOptions));
app.use(express.json());
// 主: 全能力可用, retrieval 用非默认值以验证 meta 报告的是"生效值"
app.use(createRouter(db, {
  llm: okLlm, embed: okEmbed, retrieval: { topK: 3, tokenBudget: 456 }, runtime,
}));
// 无 LLM / 无 embedding
app.use('/none', createRouter(db, { llm: null, embed: null, retrieval: { topK: 3, tokenBudget: 456 } }));
// 有 LLM 但无 embedding (隔离 embedding 依赖)
app.use('/noembed', createRouter(db, { llm: okLlm, embed: null, retrieval: { topK: 3, tokenBudget: 456 } }));
// LLM 客户端存在但未配置
app.use('/unconf', createRouter(db, { llm: unconfLlm, embed: okEmbed }));
// embedding 客户端存在但未配置 —— 这是"声明 silent 却实测抛错"最容易漏测的一格
app.use('/unconfembed', createRouter(db, { llm: okLlm, embed: unconfEmbed }));

// CORS 关闭的服务
const appNoCors = express();
appNoCors.use(createCorsMiddleware({ enabled: false }));
appNoCors.use(express.json());
appNoCors.use(createRouter(db, { llm: okLlm, embed: okEmbed }));

const server = app.listen(0);
const serverNoCors = appNoCors.listen(0);
await Promise.all([
  new Promise((r) => server.once('listening', r)),
  new Promise((r) => serverNoCors.once('listening', r)),
]);
const base = `http://127.0.0.1:${server.address().port}`;
const baseNoCors = `http://127.0.0.1:${serverNoCors.address().port}`;

async function raw(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, body: parsed };
}
const req = (p, opts) => raw(base + p, opts);

// ============================================================
// 1) /api/meta 基础契约
// ============================================================
console.log('\n--- /api/meta 基础 ---');
const meta = (await req('/api/meta')).body;
check('/api/meta ok', meta.ok === true && meta.service === 'tavern-memory-server');
check('schemaVersion / latestSupported 如实上报',
  meta.schemaVersion === getSchemaVersion(db) && meta.latestSupported === 5,
  `${meta.schemaVersion}/${meta.latestSupported}`);
check('runtime.version 透传', meta.version === '9.9.9', String(meta.version));
check('limits 如实上报绑定地址与鉴权', meta.limits.auth === false && meta.limits.boundTo === '127.0.0.1:7780');

// ============================================================
// 2) meta 报告的是"生效值", 不是写死的文档值
// ============================================================
console.log('\n--- meta 反映生效值而非硬编码 ---');
check('defaults.retrieval 取传入的 config 值 (3/456) 而非常量兜底',
  meta.defaults.retrieval.topK === 3 && meta.defaults.retrieval.tokenBudget === 456,
  JSON.stringify(meta.defaults.retrieval));

const bare = (await req('/api/meta')).body;
check('常量兜底值与 config.default.json 一致 (8/1200)',
  RETRIEVAL_FALLBACK_DEFAULTS.topK === 8 && RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget === 1200);

// ============================================================
// 3) 枚举: meta 的值必须就是 domain/constants.js 的值 (唯一语义源)
// ============================================================
console.log('\n--- 枚举与常量同源 ---');
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('enums.memoryType 与常量同源且受约束',
  meta.enums.memoryType.constrained === true
  && eqArr(meta.enums.memoryType.options.map((o) => o.value), MEMORY_TYPES.map((t) => t.value)));
check('enums.memoryScope 与常量同源',
  eqArr(meta.enums.memoryScope.options.map((o) => o.value), MEMORY_SCOPES.map((s) => s.value)));
check('enums.chunkableEntityType 与常量同源 (item/org 不在其中)',
  eqArr(meta.enums.chunkableEntityType.options.map((o) => o.value), CHUNKABLE_ENTITY_TYPES)
  && !meta.enums.chunkableEntityType.options.some((o) => o.value === 'org'));
check('enums.stanceType 标记为不受约束 (自由字符串)',
  meta.enums.stanceType.constrained === false && meta.enums.stanceType.options.length > 0);
check('enums.forgetTable 与常量同源且带 hasAccess',
  eqArr(meta.enums.forgetTable.options.map((o) => o.value), FORGET_TABLES.map((t) => t.value))
  && meta.enums.forgetTable.options.find((o) => o.value === 'stances').hasAccess === false);
check('每个枚举项都带 label (前端无需自建中文映射)',
  [...meta.enums.memoryType.options, ...meta.enums.forgetTable.options,
    ...meta.enums.entityType.options].every((o) => typeof o.label === 'string' && o.label.length > 0));

// ============================================================
// 4) 打分口径: meta 的权重必须与检索/遗忘实际使用的常量一致
// ============================================================
console.log('\n--- 打分口径同源 ---');
const wSum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
check('retrieval 权重与常量同源且和为 1',
  eqArr(meta.scoring.retrieval.weights, RETRIEVAL_SCORING.weights)
  && Math.abs(wSum(meta.scoring.retrieval.weights) - 1) < 1e-9,
  JSON.stringify(meta.scoring.retrieval.weights));
check('forget 权重与常量同源且和为 1',
  eqArr(meta.scoring.forget.weights, FORGET_SCORING.weights)
  && Math.abs(wSum(meta.scoring.forget.weights) - 1) < 1e-9);
check('forget 无访问追踪权重重归一同源 (stances 用)',
  eqArr(meta.scoring.forget.noAccessWeights, FORGET_SCORING.noAccessWeights)
  && Math.abs(wSum(meta.scoring.forget.noAccessWeights) - 1) < 1e-9);
check('supersede 阈值同源 (0.85)',
  meta.thresholds.supersedeSimilarity === THRESHOLDS.supersedeSimilarity
  && meta.thresholds.supersedeSimilarity === 0.85);
check('公式以文本形式下发 (前端原样展示, 不自己拼)',
  typeof meta.scoring.retrieval.formula === 'string' && meta.scoring.retrieval.formula.includes('0.6')
  && typeof meta.scoring.forget.formula === 'string');
check('生效规则文案齐备', ['visibility', 'softDelete', 'supersede', 'stanceEvolution', 'entityIdDuality']
  .every((k) => typeof meta.rules[k] === 'string' && meta.rules[k].length > 0));
check('注入段落顺序下发', meta.contextSections.length === 3
  && meta.contextSections[0].key === 'profile' && meta.contextSections[2].key === 'chunks');

// ============================================================
// 5) 能力标记随运行时变化
// ============================================================
console.log('\n--- 能力标记随客户端变化 ---');
check('全能力可用时 llm/embedding 均 available',
  meta.capabilities.llm.available === true && meta.capabilities.embedding.available === true);
check('client 缺失时给出 reason 而非静默 false',
  (await req('/none/api/meta')).body.capabilities.llm.reason.length > 0);
const unconfMeta = (await req('/unconf/api/meta')).body;
check('未配置完整时 available=false 且 model=null',
  unconfMeta.capabilities.llm.available === false
  && unconfMeta.capabilities.llm.configured === false
  && unconfMeta.capabilities.llm.model === null);
check('vectorSearch.available 跟随 embedding',
  (await req('/noembed/api/meta')).body.capabilities.vectorSearch.available === false);
// 前端 fetch 超时要按服务端 LLM 超时推算, 因此该数字必须在契约里, 不能由前端写死
check('llm/embedding 超时与批大小下发 (前端不写死)',
  typeof meta.capabilities.llm.timeoutMs === 'number' && meta.capabilities.llm.timeoutMs > 0
  && typeof meta.capabilities.embedding.timeoutMs === 'number'
  && typeof meta.capabilities.embedding.batchSize === 'number',
  JSON.stringify({ llm: meta.capabilities.llm.timeoutMs, embed: meta.capabilities.embedding }));

// ============================================================
// 6) 端点契约: 声明的端点必须真实存在, 能力标记必须与实测一致
// ============================================================
console.log('\n--- 端点契约与能力标记一致性 ---');
const SAMPLES = {
  'GET /health': [],
  'GET /api/status': [],
  'GET /api/meta': [],
  'POST /api/context': [{ query: 'ELARA', chatId: 'chat001' }],
  'POST /api/retrieve': [{ query: 'ELARA', chatId: 'chat001' }],
  'POST /api/extract': [{ chatId: 'chat001', text: 'x' }],
  'POST /api/extract-attributes': [{ chatId: 'chat001', text: 'x' }],
  'POST /api/extract-stances': [{ chatId: 'chat001', text: 'x' }],
  // 用不存在的人物 id, 让 profiles-derive 走"无观察块短路"分支, 便于单独验证 §11.8
  'POST /api/profiles-derive': [{ personId: 999999, characterId: '艾拉' }],
  'POST /api/memories': [{ type: 'fact', content: '契约测试写入', chatId: 'chat001' }],
  'GET /api/memories': [],
  'POST /api/chunks': [{ entityType: 'person', entityId: 1, aspect: 'x', content: 'y', chatId: 'chat001' }],
  'GET /api/chunks': [],
  'POST /api/stances': [{
    holderType: 'person', holderId: 1, targetType: 'person', targetId: 2,
    stanceType: '信任', chatId: 'chat001',
  }],
  'GET /api/stances': [],
  'POST /api/forget': [{}],
  'POST /api/forget/restore': [{ table: 'memories', id: 1 }],
};

check('meta.endpoints 与常量同源', eqArr(meta.endpoints, ENDPOINTS));
check('每个声明端点都有测试样例 (新增端点必须同步补样例)',
  meta.endpoints.every((e) => SAMPLES[`${e.method} ${e.path}`] !== undefined),
  meta.endpoints.filter((e) => SAMPLES[`${e.method} ${e.path}`] === undefined)
    .map((e) => `${e.method} ${e.path}`).join(', '));

for (const ep of meta.endpoints) {
  const [body] = SAMPLES[`${ep.method} ${ep.path}`];
  const isGet = ep.method === 'GET';

  // (a) 端点真实存在: 用"是否返回 JSON 包络"判别, 因为 Express 未匹配路由返回的是 HTML 404,
  //     而业务性 404 (如 restore 未遗忘条目) 同样是 404, 单看状态码会误判
  const exists = await req(ep.path, { method: ep.method, body: isGet ? undefined : body });
  check(`存在: ${ep.method} ${ep.path}`,
    exists.body !== null && typeof exists.body.ok === 'boolean',
    `status=${exists.status} body=${exists.body === null ? '<非 JSON, 疑似路由未挂载>' : JSON.stringify(exists.body)}`);

  // (b) needsLlm=false 的端点, 在无 LLM 服务上不得报 LLM 缺失
  const none = await req(`/none${ep.path}`, { method: ep.method, body: isGet ? undefined : body });
  const noneErr = String(none.body?.error ?? '');
  if (!ep.needsLlm) {
    check(`标记 needsLlm=false 且实测不报 LLM 缺失: ${ep.method} ${ep.path}`,
      !noneErr.includes('LLM 客户端未初始化'), `error=${noneErr}`);
  } else {
    // needsLlm=true: 必须报 LLM 缺失; 唯一例外是文档化的短路分支 (§11.8)
    const shortCircuit = ep.path === '/api/profiles-derive'
      && none.status === 200 && none.body?.chunkCount === 0;
    check(`标记 needsLlm=true 且实测确需 LLM: ${ep.method} ${ep.path}`,
      shortCircuit || (none.status === 400 && noneErr.includes('LLM 客户端未初始化')),
      `status=${none.status} error=${noneErr}`);
  }

  // (c) needsEmbedding=true 的端点, 在有 LLM 无 embedding 服务上必须报 embedding 缺失
  if (ep.needsEmbedding) {
    const noembed = await req(`/noembed${ep.path}`, { method: ep.method, body: isGet ? undefined : body });
    const err = String(noembed.body?.error ?? '');
    check(`标记 needsEmbedding=true 且实测确需 embedding: ${ep.method} ${ep.path}`,
      noembed.status === 400 && err.includes('embedding 客户端未初始化'), `status=${noembed.status} error=${err}`);
  }
}

// 与 §11.8 对齐: 无观察块时 profiles-derive 短路 —— 但注意短路发生在"客户端已注入"之后,
// 因此这里必须用"LLM 客户端存在但未配置"的 /unconf, 而不是 llm=null 的 /none
const shortCircuit = await req('/unconf/api/profiles-derive', { method: 'POST', body: { personId: 999999, characterId: '艾拉' } });
check('profiles-derive 无观察块时短路返回 200 (不触达 LLM, 故未配置 LLM 也是 200)',
  shortCircuit.status === 200 && shortCircuit.body.ok === true
  && shortCircuit.body.entries.length === 0 && shortCircuit.body.chunkCount === 0,
  `status=${shortCircuit.status} ${JSON.stringify(shortCircuit.body)}`);
// 次序事实: llm=null 时, 更早的客户端检查先于短路判定, 返回 400
const nullLlmDerive = await req('/none/api/profiles-derive', { method: 'POST', body: { personId: 999999, characterId: '艾拉' } });
check('llm 客户端未注入时 profiles-derive 先报 400 (早于短路判定)',
  nullLlmDerive.status === 400 && nullLlmDerive.body.error === 'LLM 客户端未初始化');
// 有观察块时才会真正触达 LLM
const reallyDerives = await req('/api/profiles-derive', { method: 'POST', body: { personId: 1, characterId: '艾拉' } });
check('profiles-derive 有观察块时确实走到 LLM (chunkCount>0)',
  reallyDerives.body.ok === true && reallyDerives.body.chunkCount > 0,
  JSON.stringify(reallyDerives.body));

// 恢复端点语义 (对应 RULES.forgetRestoreScope): 仅作用于已遗忘条目
const restoreActive = await req('/api/forget/restore', { method: 'POST', body: { table: 'memories', id: 1 } });
check('restore 未遗忘条目 -> 404', restoreActive.status === 404 && restoreActive.body.ok === false);
await req('/api/memories/1', { method: 'DELETE' });
const restoreForgotten = await req('/api/forget/restore', { method: 'POST', body: { table: 'memories', id: 1 } });
check('restore 已遗忘条目 -> 200', restoreForgotten.status === 200 && restoreForgotten.body.ok === true);
const restoreTwice = await req('/api/forget/restore', { method: 'POST', body: { table: 'memories', id: 1 } });
check('重复 restore -> 404 (已恢复为生效态)', restoreTwice.status === 404);
const badTable = await req('/api/forget/restore', { method: 'POST', body: { table: 'nope', id: 1 } });
check('restore 非法表名 -> 400', badTable.status === 400 && badTable.body.error.includes('不支持的表'));

// 降级端点必须如实标注 silent
check('静默降级端点如实标注 degrade=silent',
  meta.endpoints.filter((e) => e.degrade === 'silent')
    .map((e) => e.path).sort().join(',') === '/api/chunks,/api/context,/api/retrieve',
  meta.endpoints.filter((e) => e.degrade === 'silent').map((e) => e.path).join(','));

// ============================================================
// 6b) silent 声明 vs 实测: embedding "客户端在但未配置" 时必须真的静默降级
//     这一格曾漏测 —— 守卫只判 client 是否存在, 会把未配置误判为可用, 使 /api/context 抛 400
// ============================================================
console.log('\n--- silent 声明 vs embedding 未配置实测 ---');
const unconfEmbedMeta = (await req('/unconfembed/api/meta')).body;
check('embedding 客户端存在但未配置 -> available=false 且带原因',
  unconfEmbedMeta.capabilities.embedding.configured === false
  && unconfEmbedMeta.capabilities.embedding.reason.includes('未配置'),
  JSON.stringify(unconfEmbedMeta.capabilities.embedding));
check('vectorSearch.available 随之为 false 并给出原因',
  unconfEmbedMeta.capabilities.vectorSearch.available === false
  && unconfEmbedMeta.capabilities.vectorSearch.reason.length > 0);

const ctxUnconfEmbed = await req('/unconfembed/api/context', { method: 'POST', body: { query: 'ELARA', chatId: 'chat001' } });
check('embedding 未配置: /api/context 仍 200 (无【相关细节】段, 画像/FTS 记忆照常)',
  ctxUnconfEmbed.status === 200 && ctxUnconfEmbed.body.ok === true
  && ctxUnconfEmbed.body.chunkHitCount === 0
  && !String(ctxUnconfEmbed.body.text ?? '').includes('【相关细节】'),
  `status=${ctxUnconfEmbed.status} ${JSON.stringify(ctxUnconfEmbed.body).slice(0, 200)}`);

const retrUnconfEmbed = await req('/unconfembed/api/retrieve', { method: 'POST', body: { query: 'ELARA', chatId: 'chat001' } });
check('embedding 未配置: /api/retrieve 仍 200 且无 chunkHits 字段',
  retrUnconfEmbed.status === 200 && retrUnconfEmbed.body.ok === true && !('chunkHits' in retrUnconfEmbed.body));

const chunkUnconfEmbed = await req('/unconfembed/api/chunks', {
  method: 'POST',
  body: { entityType: 'person', entityId: 1, aspect: 'x', content: '静默降级测试', chatId: 'chat001' },
});
check('embedding 未配置: POST /api/chunks -> 200 且 embedded=false',
  chunkUnconfEmbed.status === 200 && chunkUnconfEmbed.body.embedded === false, JSON.stringify(chunkUnconfEmbed.body));

check('对比: 声明 needsEmbedding=true 的抽取端点仍按 error 处理 (400)',
  (await req('/unconfembed/api/extract-attributes', { method: 'POST', body: { chatId: 'chat001', text: 'x' } }))
    .body.error.includes('embedding 未配置完整'));

// 通用断言: 凡声明 silent 的写端点, embedding 未配置时都不得因 embedding 报错
for (const ep of meta.endpoints.filter((e) => e.degrade === 'silent' && !e.needsEmbedding && e.method === 'POST')) {
  const [body] = SAMPLES[`${ep.method} ${ep.path}`];
  const r = await req(`/unconfembed${ep.path}`, { method: ep.method, body });
  check(`silent 承诺成立 (不因 embedding 报错): ${ep.method} ${ep.path}`,
    r.status === 200 && !String(r.body?.error ?? '').includes('embedding'), `status=${r.status} error=${r.body?.error ?? ''}`);
}

// ============================================================
// 7) CORS
// ============================================================
console.log('\n--- CORS ---');
const TAVERN_ORIGIN = 'http://localhost:8000';

const pre = await raw(`${base}/api/context`, {
  method: 'OPTIONS',
  headers: {
    Origin: TAVERN_ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
});
check('预检 OPTIONS 返回 204', pre.status === 204, `status=${pre.status}`);
check('预检回显来源 (非通配 *)',
  pre.headers.get('access-control-allow-origin') === TAVERN_ORIGIN
  && pre.headers.get('access-control-allow-origin') !== '*',
  String(pre.headers.get('access-control-allow-origin')));
check('预检放行 POST 与 content-type',
  pre.headers.get('access-control-allow-methods').includes('POST')
  && pre.headers.get('access-control-allow-headers').toLowerCase().includes('content-type'));
check('预检带 Vary: Origin (避免缓存串源)', String(pre.headers.get('vary') ?? '').includes('Origin'));

const localGet = await raw(`${base}/health`, { headers: { Origin: 'http://127.0.0.1:4711' } });
check('127.0.0.1 任意端口放行', localGet.headers.get('access-control-allow-origin') === 'http://127.0.0.1:4711');
const localhostGet = await raw(`${base}/api/meta`, { headers: { Origin: TAVERN_ORIGIN } });
check('localhost 任意端口放行', localhostGet.headers.get('access-control-allow-origin') === TAVERN_ORIGIN);

const whitelisted = await raw(`${base}/health`, { headers: { Origin: 'http://memory.example.test' } });
check('config 白名单来源放行',
  whitelisted.headers.get('access-control-allow-origin') === 'http://memory.example.test');

const evil = await raw(`${base}/health`, { headers: { Origin: 'http://evil.example.com' } });
check('非本机且非白名单来源不放行 CORS 头',
  evil.headers.get('access-control-allow-origin') === null, String(evil.headers.get('access-control-allow-origin')));
const evilPre = await raw(`${base}/health`, {
  method: 'OPTIONS',
  headers: { Origin: 'http://evil.example.com', 'Access-Control-Request-Method': 'GET' },
});
check('非法来源预检被拒 (403)', evilPre.status === 403, `status=${evilPre.status}`);

const noOrigin = await raw(`${base}/health`);
check('无 Origin 的普通请求照常处理 (非浏览器调用不受影响)',
  noOrigin.status === 200 && noOrigin.headers.get('access-control-allow-origin') === null);

const corsOff = await raw(`${baseNoCors}/health`, { headers: { Origin: TAVERN_ORIGIN } });
check('cors.enabled=false 时不下发任何 CORS 头',
  corsOff.status === 200 && corsOff.headers.get('access-control-allow-origin') === null);

check('/api/meta 如实报告 CORS 生效策略',
  meta.cors.enabled === true && meta.cors.allowLoopbackAnyPort === true
  && meta.cors.extraOrigins.includes('http://memory.example.test'));

// ---------- 收尾 ----------
server.close();
serverNoCors.close();
db.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
