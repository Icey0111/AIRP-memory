// 长对话压缩冒烟测试: 内存库 + mock LLM, 不触碰真实数据库
// 运行: node test/summarize.smoke.js
//
// 重点验证"摘要记忆与普通记忆同源"这件事 —— 摘要不是另存一份结构,
// 它就是一阶记忆里的 type='summary', 因此 scope/可见性/软删除/检索全部沿用同一套。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { createRouter } from '../src/api/routes.js';
import { summarizeConversation } from '../src/services/summaryService.js';
import { listMemories } from '../src/services/memoryService.js';
import { SUMMARY_POLICY } from '../src/domain/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MOCK_JSON = JSON.stringify({
  summary: '暴雨夜主角躲进夜莺酒馆, 与精灵游侠艾拉同桌。两人互通姓名, 艾拉起初戒备, '
    + '在主角替她挡下一名醉汉的纠缠后态度转缓, 约定次日结伴出城。',
  keywords: '艾拉 夜莺酒馆 结伴 暴雨',
  key_points: ['与艾拉在酒馆初遇', '艾拉态度由戒备转为亲近', '约定次日结伴出城'],
});

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});
console.log(`schema_version = ${getSchemaVersion(db)}`);

const llm = createLlmClient({ provider: 'mock', mockResponse: MOCK_JSON });

// ---------------------------------------------------------------
console.log('\n--- 首次总结 ---');
const r1 = await summarizeConversation(db, llm, {
  chatId: 'chat001',
  text: '(测试文本, mock 通道不读)',
  sourceMessageIds: ['0', '1', '2', '3'],
  characterId: '艾拉',
  keywords: '主角补充关键词',
});

check('返回摘要记忆 id', Number.isInteger(r1.memoryId) && r1.memoryId > 0);
check('未被标记为去重复用', r1.deduped === false);
check('type = summary', r1.memory.type === 'summary');
check('scope = chat 且 chatId 正确', r1.memory.scope === 'chat' && r1.memory.chatId === 'chat001');
check('正文取自模型输出', r1.memory.content.includes('夜莺酒馆'));
check('关键词合并了调用方补充与模型产出',
  r1.memory.keywords.includes('主角补充关键词') && r1.memory.keywords.includes('艾拉'));
check('importance 取策略默认值', r1.memory.importance === SUMMARY_POLICY.defaultImportance,
  `实际 ${r1.memory.importance}`);
check('覆盖楼层落库 (供溯源与去重)',
  JSON.stringify(r1.memory.sourceMessageIds) === JSON.stringify(['0', '1', '2', '3']));
check('tags 含 summary', r1.memory.tags.includes('summary'));
check('key_points 原样带回', Array.isArray(r1.keyPoints) && r1.keyPoints.length === 3);
check('未触发截断', r1.truncated === false);

const rows = db.prepare("SELECT COUNT(*) n FROM memories WHERE type='summary'").get().n;
check('库里恰有 1 条摘要记忆', rows === 1, `实际 ${rows}`);

// ---------------------------------------------------------------
console.log('\n--- 去重: 同一批楼层再总结一次 ---');
const r2 = await summarizeConversation(db, llm, {
  chatId: 'chat001',
  text: '(重复调用)',
  sourceMessageIds: ['0', '1', '2', '3'],
});
check('标记为复用既有摘要', r2.deduped === true);
check('复用同一条记忆 id', r2.memoryId === r1.memoryId);
const rows2 = db.prepare("SELECT COUNT(*) n FROM memories WHERE type='summary'").get().n;
check('未新增记忆 (仍是 1 条)', rows2 === 1, `实际 ${rows2}`);

console.log('\n--- 楼层集合变化 -> 另起一条 ---');
const r3 = await summarizeConversation(db, llm, {
  chatId: 'chat001',
  text: '(新一批)',
  sourceMessageIds: ['0', '1', '2', '3', '4'],
});
check('未被判为重复', r3.deduped === false);
check('新建了不同 id', r3.memoryId !== r1.memoryId);
const rows3 = db.prepare("SELECT COUNT(*) n FROM memories WHERE type='summary'").get().n;
check('摘要记忆增至 2 条', rows3 === 2, `实际 ${rows3}`);

console.log('\n--- 别的聊天互不干扰 ---');
const r4 = await summarizeConversation(db, llm, {
  chatId: 'chat002',
  text: '(另一场对话)',
  sourceMessageIds: ['0', '1', '2', '3'],
});
check('不同 chatId 不触发去重', r4.deduped === false && r4.memoryId !== r1.memoryId);

// ---------------------------------------------------------------
console.log('\n--- 长度约束 ---');
const longLlm = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({ summary: '很'.repeat(5000), keywords: 'k' }),
});
const r5 = await summarizeConversation(db, longLlm, {
  chatId: 'chat003', text: '(超长输出)', sourceMessageIds: ['0'],
});
check(`超长输出被截断到策略上限 ${SUMMARY_POLICY.maxSummaryChars} 字`,
  r5.truncated === true && r5.memory.content.length <= SUMMARY_POLICY.maxSummaryChars + 1,
  `实际 ${r5.memory.content.length}`);
check('截断后仍以省略号收尾', r5.memory.content.endsWith('…'));

const r6 = await summarizeConversation(db, longLlm, {
  chatId: 'chat003', text: '(请求更短上限)', sourceMessageIds: ['1'], maxChars: 120,
});
check('maxChars 参数生效', r6.memory.content.length <= 121, `实际 ${r6.memory.content.length}`);

const r7 = await summarizeConversation(db, longLlm, {
  chatId: 'chat003', text: '(请求超策略上限)', sourceMessageIds: ['2'], maxChars: 999999,
});
check('maxChars 被钳制到策略上限 (调用方不能突破)',
  r7.memory.content.length <= SUMMARY_POLICY.maxSummaryChars + 1,
  `实际 ${r7.memory.content.length}`);

// ---------------------------------------------------------------
console.log('\n--- 入参校验 ---');
let threw = null;
try { await summarizeConversation(db, llm, { text: 'x' }); } catch (e) { threw = e; }
check('缺 chatId -> 抛错', threw !== null && threw.message.includes('chatId'));

threw = null;
try { await summarizeConversation(db, llm, { chatId: 'c', text: '   ' }); } catch (e) { threw = e; }
check('空文本 -> 抛错', threw !== null && threw.message.includes('text'));

const noSummaryLlm = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({ keywords: '只有关键词' }),
});
threw = null;
try { await summarizeConversation(db, noSummaryLlm, { chatId: 'c', text: 'x', sourceMessageIds: ['9'] }); } catch (e) { threw = e; }
check('模型没给 summary 正文 -> 抛错而非写入空记忆',
  threw !== null && threw.message.includes('summary'));

// 失败调用不应留下脏数据
// 到此为止的合法写入: chat001 两条(r1/r3) + chat002 一条(r4) + chat003 三条(r5/r6/r7)
const total = db.prepare("SELECT COUNT(*) n FROM memories WHERE type='summary'").get().n;
check('校验失败的调用没有写入任何记忆', total === 6, `实际 ${total}`);

// ---------------------------------------------------------------
console.log('\n--- 可见性沿用一阶记忆口径 ---');
const visible = listMemories(db, { chatId: 'chat001', type: 'summary' });
check('listMemories(chatId=chat001, type=summary) 恰能看到本聊天 2 条',
  visible.length === 2, `实际 ${visible.length}`);
const other = listMemories(db, { chatId: 'chat999', type: 'summary' });
check('别的聊天看不到 (scope=chat 隔离生效)', other.length === 0, `实际 ${other.length}`);

// ---------------------------------------------------------------
console.log('\n--- HTTP 链路 ---');
const app = express();
app.use(express.json());
app.use(createRouter(db, { llm, embed: null }));
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function req(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const h1 = await req('/api/summarize', {
  chatId: 'chat010', text: '用户: 你好\n艾拉: 你也好', sourceMessageIds: ['0', '1'],
});
check('POST /api/summarize -> 200', h1.status === 200 && h1.body.ok === true,
  `status=${h1.status} ${JSON.stringify(h1.body).slice(0, 180)}`);
check('HTTP 返回摘要记忆 id', Number.isInteger(h1.body.memoryId));

const h2 = await req('/api/summarize', { chatId: 'chat010', text: '' });
check('空文本 -> 400 且错误文案来自服务端', h2.status === 400 && typeof h2.body.error === 'string',
  `status=${h2.status} error=${h2.body.error}`);

const h3 = await req('/api/summarize', { text: 'x' });
check('缺 chatId -> 400', h3.status === 400 && h3.body.error.includes('chatId'));

// LLM 未注入时必须如实报错 (与 /api/meta 的 needsLlm 声明一致)
const appNoLlm = express();
appNoLlm.use(express.json());
appNoLlm.use(createRouter(db, { llm: null, embed: null }));
const server2 = appNoLlm.listen(0);
const res3 = await fetch(`http://127.0.0.1:${server2.address().port}/api/summarize`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chatId: 'c', text: 'x' }),
});
const body3 = await res3.json();
check('未注入 LLM -> 400 "LLM 客户端未初始化" (与 needsLlm=true 声明一致)',
  res3.status === 400 && body3.error === 'LLM 客户端未初始化',
  `status=${res3.status} error=${body3.error}`);

server.close();
server2.close();

// ---------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
