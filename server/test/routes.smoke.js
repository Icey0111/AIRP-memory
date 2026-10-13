// 路由层冒烟测试: 真实 express + createRouter 起 HTTP 服务, 校验 HTTP 契约
// 重点钉死两处易静默回归的点 (对应 docs/api.md §10 / §11):
//   1) config.retrieval.{topK,tokenBudget} 真的被路由读取, 而非硬编码 8/1200
//   2) LLM / embedding 缺失时的错误文案, 以及"静默降级 vs 报错"的边界
// 运行: node test/routes.smoke.js
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createRouter, jsonErrorHandler } from '../src/api/routes.js';
import { createConfigApi } from '../src/services/configService.js';
import { createMemory } from '../src/services/memoryService.js';
import { addChunk } from '../src/services/chunkService.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { createEmbeddingClient } from '../src/services/embeddingClient.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

// ---------- 内存库 + 种子数据 ----------
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});
console.log(`schema_version = ${getSchemaVersion(db)}`);

// 5 条记忆共用同一 ASCII 关键词, 规避 unicode61 对中文"连续整段成词"的歧义
for (let i = 1; i <= 5; i++) {
  createMemory(db, {
    type: 'fact', content: `第 ${i} 条记忆内容`, keywords: 'ELARA',
    scope: 'chat', chatId: 'chat001', importance: 0.5 + i * 0.01,
  });
}

// ---------- 客户端矩阵 ----------
// 可用的 mock (LLM 返回一条观察, 便于走到 embedding 环节)
const okLlm = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    observations: [{ entity_type: 'person', entity_name: '甲', aspect: 'x', content: '一条观察' }],
  }),
});
const okEmbed = createEmbeddingClient({ provider: 'mock', mockDim: 64 });
// 客户端存在但配置缺失 (真实场景: provider=openai-compatible 但 key/model 为空)
const unconfLlm = createLlmClient({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' });
const unconfEmbed = createEmbeddingClient({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' });

// ---------- 用不同依赖装配多个 router, 挂在不同前缀下 ----------
const app = express();
app.use(express.json());
// 主: 全可用, retrieval 用非默认值以验证"配置真的生效"
app.use(createRouter(db, { llm: okLlm, embed: okEmbed, retrieval: { topK: 2, tokenBudget: 333 } }));
// llm 完全不注入
app.use('/nollm', createRouter(db, { llm: null, embed: okEmbed }));
// llm 客户端存在但未配置
app.use('/unconf', createRouter(db, { llm: unconfLlm, embed: okEmbed }));
// embedding 未注入 (静默降级)
app.use('/noembed', createRouter(db, { llm: okLlm, embed: null }));
// embedding 客户端存在但未配置 (报错)
app.use('/unconfembed', createRouter(db, { llm: okLlm, embed: unconfEmbed }));
// 配置读写: 挂临时配置文件 (真实场景是 server/config.json)
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cfg-'));
const cfgPath = path.join(cfgDir, 'config.json');
const cfgDefaults = {
  llm: { provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '', timeoutMs: 60000 },
  embedding: { provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' },
};
const rebuilt = [];
let llmForCfg = null;
let embedForCfg = null;
app.use('/cfg', createRouter(db, {
  clients: { get llm() { return llmForCfg; }, get embed() { return embedForCfg; } },
  configApi: createConfigApi({
    filePath: cfgPath,
    defaults: cfgDefaults,
    rebuild(merged) {
      rebuilt.push(merged);
      llmForCfg = createLlmClient(merged.llm);
      embedForCfg = createEmbeddingClient(merged.embedding);
    },
  }),
}));
// 统一 JSON 错误响应 (body 解析失败 / 超限), 与 index.js 同口径
app.use(jsonErrorHandler);

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------- 1) 运维端点 ----------
console.log('\n--- 运维 ---');
const health = await req('GET', '/health');
check('GET /health 契约', health.status === 200
  && health.body.ok === true && health.body.service === 'tavern-memory-server');

const status = await req('GET', '/api/status');
check('GET /api/status 版本正确', status.body.schemaVersion === 8 && status.body.latestSupported === 8);
check('GET /api/status 计数反映种子数据', status.body.counts.memories === 5,
  `memories=${status.body.counts.memories}`);

// ---------- 2) config.retrieval 真的生效 (本次审计的核心回归点) ----------
console.log('\n--- config.retrieval 生效 ---');
const ctxDefault = await req('POST', '/api/context', { query: 'ELARA', chatId: 'chat001' });
check('tokenBudget 取 config 默认值 (333, 非硬编码 1200)',
  ctxDefault.body.tokenBudget === 333, `实际 ${ctxDefault.body.tokenBudget}`);
check('topK 取 config 默认值 (2): 命中被截断到 2 条',
  ctxDefault.body.hitCount === 2, `实际 ${ctxDefault.body.hitCount}`);

const ctxOverride = await req('POST', '/api/context', {
  query: 'ELARA', chatId: 'chat001', topK: 5, tokenBudget: 999,
});
check('请求体 tokenBudget 覆盖 config (999)',
  ctxOverride.body.tokenBudget === 999, `实际 ${ctxOverride.body.tokenBudget}`);
check('请求体 topK 覆盖 config (5)',
  ctxOverride.body.hitCount === 5, `实际 ${ctxOverride.body.hitCount}`);

// ---------- 2b) 注入形态开关经 HTTP 生效 (前端只下发偏好, 渲染与回退都在服务端) ----------
console.log('\n--- 注入形态开关 ---');
check('默认走表格形态', ['tables', 'mixed'].includes(ctxDefault.body.injectionMode),
  String(ctxDefault.body.injectionMode));
check('默认表格化与立场段都开',
  ctxDefault.body.tablesEnabled === true && ctxDefault.body.stancesEnabled === true,
  JSON.stringify({ t: ctxDefault.body.tablesEnabled, s: ctxDefault.body.stancesEnabled }));

const ctxBullets = await req('POST', '/api/context', {
  query: 'ELARA', chatId: 'chat001', injectTables: false,
});
check('injectTables=false -> injectionMode=bullets (无损回退)',
  ctxBullets.body.injectionMode === 'bullets', String(ctxBullets.body.injectionMode));
check('回退后不再出现对齐表的分隔行',
  !/^-{3,}/m.test(String(ctxBullets.body.text ?? '')), String(ctxBullets.body.text ?? '').slice(0, 100));

const ctxNoStance = await req('POST', '/api/context', {
  query: 'ELARA', chatId: 'chat001', injectStances: false,
});
check('injectStances=false -> 只关立场段, 表格化仍开',
  ctxNoStance.body.stancesEnabled === false && ctxNoStance.body.tablesEnabled === true,
  JSON.stringify({ t: ctxNoStance.body.tablesEnabled, s: ctxNoStance.body.stancesEnabled }));

// 未决命题开关同样经 HTTP 生效 (缺省开)
const ctxPendingOff = await req('POST', '/api/context', {
  query: 'ELARA', chatId: 'chat001', injectPending: false,
});
check('injectPending=false -> 未决段不注入 (pendingEnabled=false, 段文本缺席)',
  ctxPendingOff.body.pendingEnabled === false && ctxPendingOff.body.pendingCount === 0
  && !String(ctxPendingOff.body.text ?? '').includes('【待兑现】'),
  JSON.stringify({ on: ctxPendingOff.body.pendingEnabled, n: ctxPendingOff.body.pendingCount }));
check('缺省时未决段启用 (pendingEnabled=true)',
  ctxDefault.body.pendingEnabled === true, String(ctxDefault.body.pendingEnabled));

const retrDefault = await req('POST', '/api/retrieve', { query: 'ELARA', chatId: 'chat001' });
check('POST /api/retrieve hits 受 config.topK 约束 (=2)',
  retrDefault.body.hits.length === 2, `实际 ${retrDefault.body.hits.length}`);

// ---------- 3) LLM 缺失 vs 未配置: 两种不同文案 ----------
console.log('\n--- LLM 文案 ---');
const noLlm = await req('POST', '/nollm/api/extract', { chatId: 'c', text: 'x' });
check('llm 完全不注入 -> 400 "LLM 客户端未初始化"',
  noLlm.status === 400 && noLlm.body.error === 'LLM 客户端未初始化', JSON.stringify(noLlm.body));

const unconf = await req('POST', '/unconf/api/extract', { chatId: 'c', text: 'x' });
check('llm 客户端存在但未配置 -> 400 "llm 未配置完整 ..."',
  unconf.status === 400
  && unconf.body.error === 'llm 未配置完整 (baseUrl/apiKey/model), 请编辑 server/config.json',
  JSON.stringify(unconf.body));

// 注意: 目标人物没有任何生效观察块时, deriveProfile 会直接短路返回, 不会触达 LLM
const deriveEmpty = await req('POST', '/api/profiles-derive', { personId: 424242, characterId: '艾拉' });
check('profiles-derive 无观察块 -> 短路返回空, 未触达 LLM',
  deriveEmpty.body.ok === true && deriveEmpty.body.entries.length === 0
  && deriveEmpty.body.chunkCount === 0, JSON.stringify(deriveEmpty.body));

// 预置一条生效观察块, 才能走到 LLM 调用
addChunk(db, {
  entityType: 'person', entityId: 1, aspect: 'personality',
  content: '甲很冷静', chatId: 'chat001', importance: 0.5,
});
const unconfDerive = await req('POST', '/unconf/api/profiles-derive', { personId: 1, characterId: '艾拉' });
check('profiles-derive 有观察块时走未配置文案', unconfDerive.status === 400
  && unconfDerive.body.error.startsWith('llm 未配置完整'), JSON.stringify(unconfDerive.body));

const unconfStances = await req('POST', '/unconf/api/extract-stances', { chatId: 'c', text: 'x' });
check('extract-stances 同样走未配置文案', unconfStances.status === 400
  && unconfStances.body.error.startsWith('llm 未配置完整'), JSON.stringify(unconfStances.body));

const missingArg = await req('POST', '/api/profiles-derive', { personId: 1 });
check('profiles-derive 缺 characterId -> 400 必填提示',
  missingArg.status === 400 && missingArg.body.error === 'personId/characterId 必填',
  JSON.stringify(missingArg.body));

// ---------- 4) embedding 缺失: 静默降级 vs 报错 ----------
console.log('\n--- embedding 降级边界 ---');
const retrNoEmbed = await req('POST', '/noembed/api/retrieve', { query: 'ELARA', chatId: 'chat001' });
check('embed 未注入: /api/retrieve 无 chunkHits 字段 (静默降级, 仍 ok)',
  retrNoEmbed.body.ok === true && !('chunkHits' in retrNoEmbed.body),
  JSON.stringify(Object.keys(retrNoEmbed.body)));

const ctxNoEmbed = await req('POST', '/noembed/api/context', { query: 'ELARA', chatId: 'chat001' });
check('embed 未注入: /api/context 仍 ok (只用 FTS + 画像)',
  ctxNoEmbed.body.ok === true && ctxNoEmbed.body.chunkHitCount === 0,
  JSON.stringify(ctxNoEmbed.body.chunkHitCount));

const chunkNoEmbed = await req('POST', '/noembed/api/chunks', {
  entityType: 'person', entityId: 1, aspect: 'x', content: '测试', chatId: 'chat001',
});
check('embed 未注入: POST /api/chunks -> embedded:false (静默降级)',
  chunkNoEmbed.body.ok === true && chunkNoEmbed.body.embedded === false, JSON.stringify(chunkNoEmbed.body));

const attrUnconfEmbed = await req('POST', '/unconfembed/api/extract-attributes', { chatId: 'c', text: 'x' });
check('embed 客户端存在但未配置: /api/extract-attributes -> 400 "embedding 未配置完整 ..."',
  attrUnconfEmbed.status === 400 && attrUnconfEmbed.body.error.startsWith('embedding 未配置完整'),
  JSON.stringify(attrUnconfEmbed.body));

// ---------- 5) 通用错误语义 ----------
console.log('\n--- 通用错误语义 ---');
const notFound = await req('GET', '/api/memories/999999');
check('GET 不存在的记忆 -> 404', notFound.status === 404 && notFound.body.ok === false);

const chunksNoArgs = await req('GET', '/api/chunks');
check('GET /api/chunks 缺 entityType/entityId -> 400',
  chunksNoArgs.status === 400 && chunksNoArgs.body.error === 'entityType/entityId 必填');

const badType = await req('POST', '/api/memories', { type: 'nope', content: 'x' });
check('POST /api/memories 非法 type -> 400',
  badType.status === 400 && badType.body.ok === false, JSON.stringify(badType.body));

// ---------- 6) 统一 JSON 错误响应 + limit 钳制 ----------
console.log('\n--- 统一 JSON 错误响应 / limit 钳制 ---');
// 裸请求: 发非法 JSON (req 助手会 stringify, 这里绕开它)
async function rawReq(method, p, rawBody) {
  const res = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: rawBody,
  });
  return { status: res.status, body: await res.json() };
}
const malformed = await rawReq('POST', '/api/memories', '{not json');
check('非法 JSON body -> 400 {ok:false} 而非 HTML 错误页 (统一错误中间件)',
  malformed.status === 400 && malformed.body.ok === false
  && String(malformed.body.error).startsWith('请求体解析失败'),
  JSON.stringify(malformed.body));

const listAll = await req('GET', '/api/memories?limit=99999&chatId=chat001');
check('GET /api/memories limit 超界被钳制到上限 200',
  listAll.status === 200, JSON.stringify(listAll.status));

// 造 >200 行才能真正触发钳制 (直接 SQL 批量插, 不走 createMemory)
const bulk = db.prepare(`
  INSERT INTO memories (type, content, keywords, importance, scope, chat_id, created_at, updated_at)
  VALUES ('fact', 'bulk', '', 0.5, 'chat', 'chat-bulk', 0, 0)
`);
db.transaction(() => { for (let i = 0; i < 210; i++) bulk.run(); })();
const listClamped = await req('GET', '/api/memories?limit=99999&chatId=chat-bulk');
check('limit=99999 实际只返回 200 行 (MAX_LIST_LIMIT 生效)',
  listClamped.status === 200 && listClamped.body.memories.length === 200,
  `实际 ${listClamped.body.memories?.length}`);

// ---------- 8) 模型配置读写 (密钥只落服务端, 读取打码) ----------
console.log('\n--- /api/config ---');
check('未提供 configApi 的 router: GET 报明确错误 (不静默假装成功)',
  (await req('GET', '/api/config')).body.error?.includes('配置读写未启用'));

const cfgEmpty = await req('GET', '/cfg/api/config');
check('初始视图: 未配置时 apiKeySet=false 且打码为空',
  cfgEmpty.status === 200 && cfgEmpty.body.config.llm.apiKeySet === false
  && cfgEmpty.body.config.llm.apiKey === '',
  JSON.stringify(cfgEmpty.body.config?.llm));

const cfgSave = await req('POST', '/cfg/api/config', {
  llm: { baseUrl: 'https://relay.example/v1', apiKey: 'sk-test-abcd1234', model: 'glm-5' },
});
check('保存成功: 返回打码视图 (•••• + 末4位), 明文不出现在任何响应里',
  cfgSave.status === 200
  && cfgSave.body.config.llm.apiKey.startsWith('••••')
  && cfgSave.body.config.llm.apiKey.endsWith('1234')
  && !JSON.stringify(cfgSave.body).includes('sk-test-abcd1234'),
  JSON.stringify(cfgSave.body.config?.llm));
check('热重建已发生 (rebuild 回调被调, 客户端自描述更新)',
  rebuilt.length === 1 && cfgSave.body.llm?.configured === true
  && cfgSave.body.llm?.model === 'glm-5',
  JSON.stringify(cfgSave.body.llm));

const cfgKeep = await req('POST', '/cfg/api/config', {
  llm: { model: 'glm-5-air', apiKey: '' },              // 空 apiKey = 保持不变
});
check('回传空密钥 = 保持不变 (不会把已存密钥冲掉)',
  cfgKeep.status === 200 && cfgKeep.body.config.llm.apiKeySet === true
  && cfgKeep.body.config.llm.model === 'glm-5-air',
  JSON.stringify(cfgKeep.body.config?.llm));

const cfgMaskEcho = await req('POST', '/cfg/api/config', {
  llm: { apiKey: cfgKeep.body.config.llm.apiKey },       // 打码回显值原样传回 = 保持不变
});
check('回传打码值 = 保持不变 (打码值当不动处理)',
  cfgMaskEcho.status === 200 && cfgMaskEcho.body.config.llm.apiKeySet === true);

const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
check('密钥已明文写入服务端配置文件 (gitignored), 非默认节不落盘',
  onDisk.llm.apiKey === 'sk-test-abcd1234' && onDisk.llm.model === 'glm-5-air'
  && onDisk.llm.baseUrl === 'https://relay.example/v1'
  && onDisk.embedding === undefined,
  JSON.stringify(Object.keys(onDisk)));

const cfgForbidden = await req('POST', '/cfg/api/config', { server: { port: 9999 } });
check('非 llm/embedding 配置节被拒绝 (端口等只能改文件)',
  cfgForbidden.status === 400 && cfgForbidden.body.error?.includes('不允许修改'),
  JSON.stringify(cfgForbidden.body));

// ---------- 收尾 ----------
server.close();
db.close();
fs.rmSync(cfgDir, { recursive: true, force: true });
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
