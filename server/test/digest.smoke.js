// 前情提要冒烟测试: 摘要必须"按楼层顺序、必然在场"
// 运行: node test/digest.smoke.js
//
// 这个文件存在的理由 (核心命题):
//   摘要覆盖的正文已被 /hide 移出 prompt, 摘要是那段剧情唯一的载体。
//   若摘要走相似度检索, 当前轮关键词不命中就整段丢失 —— 被隐藏的区间在模型眼里成空洞。
//   所以摘要必须是独立段落、按楼层顺序常驻、不参与打分, 并且在相似度召回里被排除。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createRouter } from '../src/api/routes.js';
import { createMemory } from '../src/services/memoryService.js';
import { buildDigest, resolveDigestTokens, listChatSummaries } from '../src/services/digestService.js';
import { assembleContext } from '../src/services/retrievalService.js';
import { SUMMARY_POLICY, DIGEST_FORMAT, SUMMARY_MEMORY_TYPE } from '../src/domain/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});
console.log(`schema_version = ${getSchemaVersion(db)}`);

/** 造一条摘要记忆; floors 决定覆盖区间 */
function addSummary({ chatId, content, from, to, importance = 0.6 }) {
  const ids = [];
  for (let i = from; i <= to; i++) ids.push(String(i));
  return createMemory(db, {
    type: 'summary', content, scope: 'chat', chatId,
    sourceMessageIds: ids, importance, tags: ['summary'],
  });
}

const HEADER = DIGEST_FORMAT.header;

// ===============================================================
console.log('\n--- 按楼层顺序拼链 ---');
addSummary({ chatId: 'c1', content: '第一段剧情', from: 0, to: 9 });
addSummary({ chatId: 'c1', content: '第二段剧情', from: 10, to: 19 });
addSummary({ chatId: 'c1', content: '第三段剧情', from: 20, to: 29 });

const d1 = buildDigest(db, { chatId: 'c1' });
check('三条摘要全部入选 (默认预算下不截断)', d1.count === 3 && d1.truncated === false,
  JSON.stringify({ count: d1.count, truncated: d1.truncated }));
check('按楼层先后排列, 最早在前',
  d1.text.indexOf('第一段剧情') < d1.text.indexOf('第二段剧情')
  && d1.text.indexOf('第二段剧情') < d1.text.indexOf('第三段剧情'));
check(`段落带 ${DIGEST_FORMAT.header} 头`, d1.text.startsWith(HEADER), d1.text.slice(0, 30));
check('每行行首是覆盖的楼层区间 (供模型定位时序)',
  d1.text.includes('[0-9]') && d1.text.includes('[20-29]'), d1.text.slice(0, 80));
check('上报整体覆盖区间', d1.fromFloor === 0 && d1.toFloor === 29,
  JSON.stringify({ from: d1.fromFloor, to: d1.toFloor }));
check('ids 与写入顺序一致', d1.ids.length === 3 && d1.ids.every((x, i) => i === 0 || x > d1.ids[i - 1]));

// ===============================================================
console.log('\n--- 只取本聊天 (不跨聊天拼链) ---');
addSummary({ chatId: 'c2', content: '别的聊天的剧情', from: 100, to: 109 });
const d2 = buildDigest(db, { chatId: 'c2' });
check('c2 只看到自己那一条', d2.count === 1 && d2.text.includes('别的聊天的剧情')
  && !d2.text.includes('第一段剧情'));
check('c1 不受 c2 影响', buildDigest(db, { chatId: 'c1' }).count === 3);
check('无 chatId 时返回空 (不猜)',
  buildDigest(db, {}).count === 0 && buildDigest(db, {}).text === '');
check('无摘要的聊天返回空段', (() => {
  const e = buildDigest(db, { chatId: 'c-empty' });
  return e.count === 0 && e.text === '' && e.tokens === 0 && e.truncated === false;
})());

// ===============================================================
console.log('\n--- 预算不足: 保新丢旧 ---');
// 造三条等长摘要 (正文 300 字符)
const big = 'x'.repeat(299);
const b1 = addSummary({ chatId: 'c3', content: `甲${big}`, from: 0, to: 9 });
const b2 = addSummary({ chatId: 'c3', content: `乙${big}`, from: 10, to: 19 });
const b3 = addSummary({ chatId: 'c3', content: `丙${big}`, from: 20, to: 29 });
const all = buildDigest(db, { chatId: 'c3' });

// 单行成本从实测反推 (不手算字符数); 1 行放得下、3 行放不下 -> 恰好留 2 行
const probe = buildDigest(db, { chatId: 'c3', maxTokens: 1 });
const cap = probe.tokens + 200;
const d3 = buildDigest(db, { chatId: 'c3', maxTokens: cap });

check('超预算时截断, 条目数减少', d3.count === 2 && d3.truncated === true,
  JSON.stringify({ count: d3.count, total: d3.total, cap, probe: probe.tokens }));
check('保留的是"最新的一批" (保新丢旧的实质)',
  JSON.stringify(d3.ids) === JSON.stringify(all.ids.slice(-d3.count)),
  JSON.stringify({ kept: d3.ids, all: all.ids }));
check('丢掉的是最早那条', !d3.ids.includes(b1.id) && d3.ids.includes(b2.id) && d3.ids.includes(b3.id),
  JSON.stringify({ ids: d3.ids, b1: b1.id, b2: b2.id, b3: b3.id }));
check('丢了几条如实上报', d3.droppedCount === d3.total - d3.count && d3.droppedCount === 1,
  `实际 ${d3.droppedCount}`);
check('整体覆盖区间随保留内容收缩', d3.fromFloor === 10 && d3.toFloor === 29,
  JSON.stringify({ from: d3.fromFloor, to: d3.toFloor, allFrom: all.fromFloor }));
check('默认预算下三条都放得下', all.count === 3);

// ===============================================================
console.log('\n--- 预算极小: 至少保留最新一条 (前情提要不会为空) ---');
check('预算再小也保留最新一条', probe.count === 1 && probe.ids[0] === b3.id,
  JSON.stringify({ count: probe.count, ids: probe.ids }));
check('此时截断标记为真', probe.truncated === true && probe.droppedCount === 2);

// ===============================================================
console.log('\n--- 预算解析 (调用方可覆盖, 但不得越界) ---');
check('未传 -> 策略默认值',
  resolveDigestTokens(null) === SUMMARY_POLICY.digest.maxTokens
  && resolveDigestTokens(0) === SUMMARY_POLICY.digest.maxTokens);
check('负数按"用默认"处理 (与 topK/tokenBudget 同一约定)',
  resolveDigestTokens(-5) === SUMMARY_POLICY.digest.maxTokens);
check('正常覆盖值原样生效', resolveDigestTokens(500) === 500);
check('超过上限被钳制到策略上限',
  resolveDigestTokens(999999) === SUMMARY_POLICY.digest.limits.max,
  `得到 ${resolveDigestTokens(999999)}`);
check('低于下限被抬到下限', resolveDigestTokens(0.5) === SUMMARY_POLICY.digest.limits.min,
  `得到 ${resolveDigestTokens(0.5)}`);

// ===============================================================
console.log('\n--- 摘要不参与相似度召回 (否则会在两处重复占位) ---');
// FTS 的中文按连续 CJK 整段成词, 因此用空格分词保证两边都能命中同一个词
addSummary({ chatId: 'c4', content: '艾拉 在夜莺酒馆 初见 主角', from: 0, to: 9 });
const fact = createMemory(db, {
  type: 'fact', content: '艾拉 是 精灵 游侠', scope: 'chat', chatId: 'c4', importance: 0.9,
});

const ctx = await assembleContext(db, null, { query: '艾拉', chatId: 'c4' });
check('注入文本里有【前情提要】段', ctx.text.includes(HEADER), ctx.text.slice(0, 60));
check('前情提要统计如实上报',
  ctx.digestCount === 1 && ctx.digestTotal === 1 && ctx.digestTokens > 0,
  JSON.stringify({ c: ctx.digestCount, t: ctx.digestTotal, tk: ctx.digestTokens }));
check('【相关记忆】不含摘要 (已在常驻段, 不重复占位)',
  ctx.hitIds.length === 1 && ctx.hitIds[0] === fact.id,
  JSON.stringify({ hitIds: ctx.hitIds, factId: fact.id }));
// 前情提要走独立预算: 收不收夹摘要, 都不该改变检索段 (usedTokens) 的用量
const ctxSmallDigest = await assembleContext(db, null, { query: '艾拉', chatId: 'c4', digestMaxTokens: 1 });
check('前情提要走独立预算, 不挤压检索段用量',
  ctxSmallDigest.usedTokens === ctx.usedTokens && ctx.usedTokens > 0,
  JSON.stringify({ used: ctx.usedTokens, withTinyDigest: ctxSmallDigest.usedTokens }));
const related = ctx.text.split('【相关记忆】')[1] ?? '';
check('摘要正文没有出现在【相关记忆】里', !related.includes('夜莺酒馆'), related.slice(0, 60));

// 摘要仍然存在于库中, 只是不走召回 (没被删除)
check('摘要只是不被召回, 数据仍在 (软删除未发生)',
  listChatSummaries(db, 'c4').length === 1);

// ===============================================================
console.log('\n--- HTTP 链路 ---');
const app = express();
app.use(express.json());
app.use(createRouter(db, { llm: null, embed: null }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const hc = await post('/api/context', { query: '艾拉', chatId: 'c4' });
check('POST /api/context -> 200 且带前情提要字段',
  hc.status === 200 && hc.body.ok === true
  && typeof hc.body.digestCount === 'number' && typeof hc.body.digestTokens === 'number'
  && typeof hc.body.digestMaxTokens === 'number',
  `status=${hc.status} ${JSON.stringify(hc.body).slice(0, 200)}`);
check('/api/context 的 digestMaxTokens 等于策略默认值',
  hc.body.digestMaxTokens === SUMMARY_POLICY.digest.maxTokens);

const hc2 = await post('/api/context', { query: '艾拉', chatId: 'c4', digestMaxTokens: 555 });
check('/api/context 接受 digestMaxTokens 覆盖', hc2.body.digestMaxTokens === 555,
  `得到 ${hc2.body.digestMaxTokens}`);

const hr = await post('/api/retrieve', { query: '艾拉', chatId: 'c4' });
check('/api/retrieve 默认也排除摘要 (与注入一致)',
  hr.body.hits.every((h) => h.type !== SUMMARY_MEMORY_TYPE),
  JSON.stringify(hr.body.hits.map((h) => h.type)));
check('/api/retrieve 附带 digest (调试时能看到实际会注入什么)',
  hr.body.digest?.count === 1 && hr.body.digest.text.includes(HEADER));

const hr2 = await post('/api/retrieve', { query: '艾拉', chatId: 'c4', includeSummaries: true });
check('显式 includeSummaries 时才把摘要放进召回结果',
  hr2.body.hits.some((h) => h.type === SUMMARY_MEMORY_TYPE));

server.close();

// ===============================================================
console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
