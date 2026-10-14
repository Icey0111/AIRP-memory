// 注入段注册表冒烟测试 —— 钉的是"声明即执行", 不是渲染效果 (那是 injection/tables 的活)
//
// 这个文件存在的理由 (重构前这里是个洞):
//   CONTEXT_SECTIONS 声明的段顺序只被 /api/meta 下发, assembleContext 里手写的顺序
//   与它**没有任何机制绑定** —— 谁把编排器里两段调个个儿, 契约与实测都不会报错。
//   现在两边由同一份注册表产出, 本文件把它钉死:
//     1) 注册表顺序 = CONTEXT_SECTIONS 顺序 (契约 = 执行)
//     2) 段与契约之间双向齐全 (不多不少)
//     3) 依赖声明真的被拓扑排序兑现 (取数顺序 ≠ 出段顺序, 但依赖必须先满足)
//     4) 依赖成环 / 指向不存在的段 -> 直接抛错, 不静默降级
//     5) 对外字段一个都不能少 (冻结历史清单, 前端与 check-contract 都在读)
//     6) 出段顺序 = 注册表顺序 (文本里段落标题的出现次序)
// 运行: node test/sections.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import {
  INJECTION_SECTIONS, sectionOrder, prepareOrder, sectionFields, assembleContext,
} from '../src/services/retrievalService.js';
import { INJECTION_TABLES, CONTEXT_SECTIONS } from '../src/domain/constants.js';
import { upsertProfileEntry } from '../src/services/profileService.js';
import { findOrCreatePerson, findOrCreateLocation, findOrCreateTimePoint, createEvent, addEventParticipant } from '../src/services/entityService.js';
import { addStance } from '../src/services/stanceService.js';
import { createMemory } from '../src/services/memoryService.js';

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

const T = INJECTION_TABLES;
const CHAT = 'chat-sections';
const CHAR = '艾拉';

// ---------- 1) 注册表 ↔ 契约 ----------
console.log('\n--- 注册表与契约同源 ---');
const regKeys = sectionOrder().map((s) => s.key);
const contractKeys = [...CONTEXT_SECTIONS].sort((a, b) => a.order - b.order).map((s) => s.key);
check('注册表顺序 = CONTEXT_SECTIONS 顺序 (契约不再只是文档)',
  regKeys.join(',') === contractKeys.join(','),
  `reg=${regKeys.join(',')} contract=${contractKeys.join(',')}`);
check('段与契约双向齐全 (不多不少)',
  regKeys.length === contractKeys.length && regKeys.every((k) => contractKeys.includes(k)),
  JSON.stringify({ reg: regKeys, contract: contractKeys }));
check('每段的 order 唯一且连续 1..N',
  sectionOrder().map((s) => s.order).join(',') === regKeys.map((_, i) => i + 1).join(','),
  sectionOrder().map((s) => s.order).join(','));
check('段的 id 与 key 同名 (一处命名, 不用记两个)',
  INJECTION_SECTIONS.every((s) => s.id === s.key));

// ---------- 2) 依赖拓扑 ----------
console.log('\n--- 取数顺序: 依赖先于使用方 ---');
const prep = prepareOrder().map((s) => s.id);
check('stances 先于 profile (画像表要用立场对端名做跨段去重)',
  prep.indexOf('stances') < prep.indexOf('profile'), prep.join(' → '));
check('timeline 先于 entities (实体热度要用时间线窗口)',
  prep.indexOf('timeline') < prep.indexOf('entities'), prep.join(' → '));
check('取数顺序与出段顺序确实不同 (这是两阶段的意义所在, 也是回归信号)',
  prep.join(',') !== sectionOrder().map((s) => s.id).join(','),
  `prep=${prep.join(',')} out=${sectionOrder().map((s) => s.id).join(',')}`);

const badCycle = [
  { id: 'a', key: 'a', order: 1, deps: ['b'], fields: {} },
  { id: 'b', key: 'b', order: 2, deps: ['a'], fields: {} },
];
let cycleErr = null;
try { prepareOrder(badCycle); } catch (err) { cycleErr = err.message; }
check('依赖成环 -> 抛错 (不静默跑成随机顺序)', cycleErr?.includes('成环'), String(cycleErr));

let missingErr = null;
try { prepareOrder([{ id: 'a', key: 'a', order: 1, deps: ['nope'], fields: {} }]); } catch (err) { missingErr = err.message; }
check('依赖指向不存在的段 -> 抛错', missingErr?.includes('不存在'), String(missingErr));

// ---------- 3) 对外字段冻结 ----------
// 这 40 个字段是从重构前 git HEAD 的实现里抽出来的契约面, 一个都不能丢:
// src/ui.js 与 check-contract.mjs 在读它们。
const LEGACY_FIELDS = ('profileCount profileTotal profileTokens profileDropped '
  + 'clockAt clockText clockInferred '
  + 'stanceCount stanceTotal stanceTokens evolvedStanceCount '
  + 'entityCount entityTotal entityTokens entityDropped '
  + 'timelineCount timelineTotal timelineTokens timelineDropped propositionRows '
  + 'pendingCount pendingTotal pendingTokens pendingDropped pendingEnabled '
  + 'tablesEnabled stancesEnabled injectionMode '
  + 'digestCount digestTotal digestTokens digestDropped digestTruncated digestIds digestMaxTokens digestFromFloor digestToFloor '
  + 'hitCount hitIds chunkHitCount chunkHitIds chunkError chunkDeduped').split(' ');

const GLOBAL_FIELDS = ['tablesEnabled', 'stancesEnabled', 'injectionMode'];
const declared = sectionFields();
check('段声明的字段 + 全局字段 = 历史字段全集 (无遗漏)',
  [...Object.keys(declared), ...GLOBAL_FIELDS].sort().join(',') === [...LEGACY_FIELDS].sort().join(','),
  JSON.stringify({
    missing: LEGACY_FIELDS.filter((f) => !(f in declared) && !GLOBAL_FIELDS.includes(f)),
    extra: [...Object.keys(declared), ...GLOBAL_FIELDS].filter((f) => !LEGACY_FIELDS.includes(f)),
  }));
check('每段都声明了 fields 与 run', INJECTION_SECTIONS.every((s) => s.fields && typeof s.run === 'function'));

// ---------- 4) 实测: 字段齐全 + 出段顺序 ----------
console.log('\n--- 实测 /api/context 组装 ---');
upsertProfileEntry(db, { characterId: CHAR, category: 'appearance', key: '发色', value: '银白' });
const [ela] = [findOrCreatePerson(db, { name: '艾拉' })];
const smith = findOrCreatePerson(db, { name: '铁匠' });
const loc = findOrCreateLocation(db, { name: '铁匠铺' });
const tp = findOrCreateTimePoint(db, { chatId: CHAT, label: '第二天清晨' });
const ev = createEvent(db, { chatId: CHAT, verbType: '拜访', title: '艾拉拜访铁匠铺', timeId: tp.id, locationId: loc.id });
addEventParticipant(db, { eventId: ev, personId: ela.id, role: 'agent' });
addStance(db, {
  holderType: 'person', holderId: ela.id, targetType: 'person', targetId: smith.id,
  stanceType: '戒备', intensity: 0.6, chatId: CHAT, basis: '曾被骗',
});
createMemory(db, { type: 'fact', content: '艾拉左手使剑', keywords: 'ELARA', scope: 'chat', chatId: CHAT });

const ctx = await assembleContext(db, null, { query: 'ELARA', chatId: CHAT, characterId: CHAR });

check('响应含全部历史字段且无 undefined',
  LEGACY_FIELDS.every((f) => ctx[f] !== undefined),
  JSON.stringify(LEGACY_FIELDS.filter((f) => ctx[f] === undefined)));
check('计数型字段都是数字',
  ['profileCount', 'stanceCount', 'entityCount', 'timelineCount', 'pendingCount', 'hitCount', 'chunkHitCount']
    .every((f) => Number.isFinite(ctx[f])),
  JSON.stringify(Object.fromEntries(['profileCount', 'stanceCount', 'entityCount', 'timelineCount', 'pendingCount', 'hitCount', 'chunkHitCount'].map((f) => [f, ctx[f]]))));
check('数组型字段都是数组 (前端 .length 直接用)',
  Array.isArray(ctx.hitIds) && Array.isArray(ctx.chunkHitIds) && Array.isArray(ctx.digestIds));
check('未参与组装的段也给出缺省 (不是 undefined)',
  ctx.digestIds.length === 0 && ctx.chunkError === null && typeof ctx.pendingEnabled === 'boolean');

// 出段顺序: 文本里各段标题的出现次序必须等于注册表顺序
const present = regKeys
  .map((k) => ({ k, header: T.headers[k] }))
  .filter(({ header }) => header && ctx.text.includes(header));
const positions = present.map(({ k, header }) => ({ k, at: ctx.text.indexOf(header) }));
const ascending = positions.every((p, i) => i === 0 || p.at > positions[i - 1].at);
check('文本里段出现次序 = 注册表顺序', ascending, JSON.stringify(positions));
check('实际出现的段 ≥ 5 (画像/立场/实体/时间线/相关记忆都该在)',
  present.length >= 5, JSON.stringify(present.map((p) => p.k)));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
