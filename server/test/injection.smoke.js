// 常驻注入段冒烟测试 (T1: 画像表 + 立场表)
// 运行: node test/injection.smoke.js
//
// 这个文件存在的理由 (核心命题):
//   常驻段是"必然在场"的记忆载体 —— 它必须始终可用、始终整齐、且不吃检索预算。
//   三条底线在这里钉死:
//     1) 表格化形态正确: 同类别/同持方只描述一次、裸 id 一律解析成人名、二阶立场语义压进"表露"一列;
//     2) 常驻段各自独立预算: 画像/立场再大也不挤占检索段 (usedTokens 只算记忆与细节);
//     3) 渲染异常自动回退 bullet: 注入永不断供, 生成本身不受影响。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { upsertProfileEntry } from '../src/services/profileService.js';
import { findOrCreatePerson, findOrCreateOrg, findOrCreateLocation } from '../src/services/entityService.js';
import { addStance, currentStances, chatStances, stanceOverview, softDeleteStance } from '../src/services/stanceService.js';
import { buildProfileTable, buildStanceTable, intensityLabel, stanceDisplayText } from '../src/services/injectionService.js';
import { assembleContext } from '../src/services/retrievalService.js';
import { createMemory } from '../src/services/memoryService.js';
import { INJECTION_TABLES } from '../src/domain/constants.js';

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
const CHAT = 'chat-a';

// ===============================================================
console.log('\n--- 画像表: 类别分组 + 归纳溯源标记 ---');
upsertProfileEntry(db, { characterId: '艾拉', category: 'appearance', key: '发色', value: '银白, 及腰' });
upsertProfileEntry(db, { characterId: '艾拉', category: 'personality', key: '说话风格', value: '冷淡克制, 句子短' });
upsertProfileEntry(db, {
  characterId: '艾拉', category: 'personality', key: '对陌生人的反应',
  value: '先观察再决定', derivedFromChunkIds: [11, 12],
});

const profile = buildProfileTable(db, { characterId: '艾拉' });
const pLines = profile.text.split('\n');
check('段落标题与常量同源', pLines[0] === T.headers.profile, pLines[0]);
check('表头三列: 类别 / 条目 / 内容',
  pLines[1].trim().replace(/\s+/g, ' ') === '类别 条目 内容', pLines[1]);
// 行序: [0]标题 [1]表头 [2]分隔行 [3..]数据行 (按 category, key 排序)
check('类别首现行带类别名, 同类别只在首行出现一次 (分组留空)',
  pLines[3].startsWith('appearance') && pLines[4].startsWith('personality')
  && pLines[5].startsWith(' ')
  && pLines.filter((l) => l.startsWith('personality')).length === 1,
  JSON.stringify(pLines.slice(3)));
check('由观察块归纳的条目标 ※, 人工设定的不标',
  pLines[4].includes(T.derivedMark) && !pLines[3].includes(T.derivedMark)
  && !pLines[5].includes(T.derivedMark),
  JSON.stringify(pLines.slice(3)));
check('上报注入条数与总数', profile.count === 3 && profile.total === 3 && profile.dropped === 0,
  JSON.stringify({ c: profile.count, t: profile.total }));
check('预算极小时至少保留一行 (常驻段不空段)',
  buildProfileTable(db, { characterId: '艾拉', maxTokens: 1 }).count === 1);
check('行数上限截断并如实上报',
  buildProfileTable(db, { characterId: '艾拉', limit: 2 }).count === 2
  && buildProfileTable(db, { characterId: '艾拉', limit: 2 }).droppedByLimit === 1);
check('无画像时不出段', buildProfileTable(db, { characterId: '不存在' }).text === '');

// ===============================================================
console.log('\n--- 立场表: 名字解析 + 二阶语义压缩 + 强度三档 ---');
const alice = findOrCreatePerson(db, { name: '艾拉', aliases: ['小艾'], personType: 'main' });
const hero = findOrCreatePerson(db, { name: '主角', personType: 'main' });
const guild = findOrCreateOrg(db, { name: '商会' });

addStance(db, {
  holderType: 'person', holderId: alice.id, targetType: 'person', targetId: hero.id,
  stanceType: '戒备', intensity: 0.5, displayedType: '友好', isPublic: false, targetAware: false,
  basis: '曾被撞见翻查卷宗', chatId: CHAT, importance: 0.9,
});
addStance(db, {
  holderType: 'person', holderId: alice.id, targetType: 'org', targetId: guild.id,
  stanceType: '利用', intensity: 0.9, chatId: CHAT, importance: 0.7,
});
addStance(db, {
  holderType: 'person', holderId: hero.id, targetType: 'person', targetId: alice.id,
  stanceType: '信任', intensity: 0.1, chatId: CHAT, importance: 0.5,
});
// 别的聊天的立场不该串进来
addStance(db, {
  holderType: 'person', holderId: hero.id, targetType: 'org', targetId: guild.id,
  stanceType: '敌视', intensity: 0.8, chatId: 'chat-b', importance: 0.99,
});

const stance = buildStanceTable(db, { chatId: CHAT });
const sLines = stance.text.split('\n');
check('段落标题与常量同源', sLines[0] === T.headers.stances, sLines[0]);
check('表头六列 (持方/对方/立场/强度/表露/依据)',
  sLines[1].trim().replace(/\s+/g, ' ') === '持方 对方 立场 强度 表露 依据', sLines[1]);
check('两端都解析成人名/组织名 (不出现裸 id)',
  stance.text.includes('艾拉') && stance.text.includes('主角') && stance.text.includes('商会')
  && !/#\d+/.test(stance.text), `\n${stance.text}`);
check('只取本聊天的立场 (别的聊天的敌视不出现)',
  !stance.text.includes('敌视'), `\n${stance.text}`);
check('同持方的相邻行"持方"列只出现一次',
  sLines.filter((l) => l.startsWith('艾拉')).length === 1, JSON.stringify(sLines));
check('强度显示三档文字 (不出现 0.5 这种数字)',
  stance.text.includes(T.intensityLabels.mid) && stance.text.includes(T.intensityLabels.high)
  && !/0\.9|0\.5|0\.1/.test(stance.text), `\n${stance.text}`);
check('表露列承载二阶语义: 隐秘·表面X·对方不知',
  stance.text.includes(`${T.stanceDisplay.hiddenPrefix}${T.stanceDisplay.disguisedPrefix}友好${T.stanceDisplay.unawareSuffix}`),
  `\n${stance.text}`);
check('表里如一的公开立场显示 即本心',
  stance.text.includes(T.stanceDisplay.plainLabel), `\n${stance.text}`);
check('依据为空显示占位符 (保住对齐)',
  stance.text.includes(T.stanceDisplay.emptyBasis), `\n${stance.text}`);
check('对端名清单可供画像跨段去重', stance.targets.includes('主角') && stance.targets.includes('商会'),
  JSON.stringify(stance.targets));
check('行数上限按 importance 先取再归拢',
  buildStanceTable(db, { chatId: CHAT, limit: 1 }).count === 1);
check('无立场时不出段', buildStanceTable(db, { chatId: 'chat-empty' }).text === '');

// 三档口径单测 (供 constants 调参时回归)
check('强度分档边界: <0.34 低, <0.67 中, ≥0.67 高',
  intensityLabel(0.33) === '低' && intensityLabel(0.34) === '中'
  && intensityLabel(0.5) === '中' && intensityLabel(0.67) === '高');
check('stanceDisplayText 纯函数口径',
  stanceDisplayText({ displayed_type: null, is_public: 1, target_aware: 1 }) === '即本心'
  && stanceDisplayText({ displayed_type: '亲近', is_public: 0, target_aware: 1 }) === '隐秘·表面亲近');

// ===============================================================
console.log('\n--- 组装: 段落顺序 + 常驻段不吃检索预算 ---');
createMemory(db, { type: 'fact', content: '艾拉 是 精灵 游侠', scope: 'chat', chatId: CHAT, importance: 0.9 });

const ctx = await assembleContext(db, null, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('注入形态标记为 tables', ctx.injectionMode === 'tables',
  JSON.stringify({ mode: ctx.injectionMode, tables: ctx.tablesEnabled }));
check('顺序: 画像 → 立场 → 相关记忆',
  ctx.text.indexOf(T.headers.profile) < ctx.text.indexOf(T.headers.stances)
  && ctx.text.indexOf(T.headers.stances) < ctx.text.indexOf(T.headers.memories),
  ctx.text.slice(0, 120));
check('常驻段统计如实上报',
  ctx.profileCount === 3 && ctx.stanceCount === 3 && ctx.stanceTotal === 3 && ctx.stanceTokens > 0,
  JSON.stringify({ p: ctx.profileCount, s: ctx.stanceCount }));

const retrievalOnly = await assembleContext(db, null, { query: '艾拉', chatId: CHAT });
check('画像/立场是常驻段, 不属于检索预算 (usedTokens 只算记忆与细节)',
  ctx.usedTokens === retrievalOnly.usedTokens && ctx.usedTokens > 0,
  JSON.stringify({ with: ctx.usedTokens, without: retrievalOnly.usedTokens }));

// ===============================================================
console.log('\n--- 跨段去重 (L3): 态度类画像条目以立场表为准 ---');
upsertProfileEntry(db, { characterId: '艾拉', category: 'relationship', key: '对主角的态度', value: '戒备中带好奇' });
upsertProfileEntry(db, { characterId: '艾拉', category: 'relationship', key: '对酒馆老板的态度', value: '客气' });
const deduped = buildProfileTable(db, { characterId: '艾拉', dedupeAgainst: ['主角'] });
check('与立场表对端重叠的态度条目被去掉',
  !deduped.text.includes('对主角的态度') && deduped.deduped === 1, `\n${deduped.text}`);
check('不重叠的态度条目保留', deduped.text.includes('对酒馆老板的态度'));
check('开关可关: dedupeAgainst 为空时全保留',
  buildProfileTable(db, { characterId: '艾拉', dedupeAgainst: [] }).text.includes('对主角的态度'));

// ===============================================================
console.log('\n--- 回退: 渲染异常时退到 bullet, 注入不断供 ---');
// 让画像查询"第一次调用抛错, 之后正常" —— 模拟一次瞬时读取失败
function flakyDb(alwaysFail) {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          if (String(sql).includes('character_profiles')) {
            calls++;
            if (alwaysFail || calls === 1) throw new Error('boom');
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const fb = await assembleContext(flakyDb(false), null, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('画像表渲染失败 -> 该段回退 bullet (不抛错)',
  fb.text.includes(T.headers.profile) && fb.text.includes('- [appearance] 发色: 银白, 及腰'),
  fb.text.slice(0, 160));
check('其余段不受影响 (立场表照常)',
  fb.text.includes(T.headers.stances) && fb.stanceCount === 3);
check('形态标记为 mixed (部分回退)', fb.injectionMode === 'mixed', fb.injectionMode);

const dead = await assembleContext(flakyDb(true), null, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('画像段彻底失败时整段跳过, 注入链不中断 (其余段照常输出)',
  !dead.text.includes(T.headers.profile) && dead.profileCount === 0
  && dead.text.includes(T.headers.stances) && dead.injectionMode === 'mixed',
  dead.text.slice(0, 160));

// embedding 服务故障 (超时/网关错误): 向量召回是外部网络依赖,
// 挂了只应丢【相关细节】一段, 注入绝不能断供 (degrade='silent' 契约的运行时侧)
console.log('\n--- 回退: embedding 服务故障时注入照常 ---');
const brokenEmbed = {
  model: 'broken',
  async embed() { throw new Error('embedding 请求失败 502: Bad Gateway'); },
};
const noVec = await assembleContext(db, brokenEmbed, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('向量召回失败 -> 注入照常返回, 相关细节段静默缺席 (不抛错)',
  noVec.text.includes(T.headers.profile) && noVec.text.includes(T.headers.memories)
  && !noVec.text.includes(T.headers.chunks),
  noVec.text.slice(0, 160));
check('失败原因如实上报 (chunkError), 命中数为 0',
  typeof noVec.chunkError === 'string' && noVec.chunkError.includes('502')
  && noVec.chunkHitCount === 0,
  JSON.stringify({ err: noVec.chunkError, n: noVec.chunkHitCount }));
check('形态标记为 mixed (部分降级)', noVec.injectionMode === 'mixed', noVec.injectionMode);

const goodVec = await assembleContext(db, null, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('正常路径 (无 embedding) chunkError 为 null', goodVec.chunkError === null);

// ===============================================================
console.log('\n--- 开关 ---');
const bullets = await assembleContext(db, null, {
  query: '艾拉', chatId: CHAT, characterId: '艾拉', injectTables: false,
});
check('injectTables=false -> 回到 bullet 路径, 立场段一并关闭',
  bullets.injectionMode === 'bullets' && bullets.text.includes('- [personality]')
  && !bullets.text.includes(T.headers.stances),
  bullets.text.slice(0, 160));
check('bullet 路径的画像条数上报不变', bullets.profileCount === 5, String(bullets.profileCount));

const noStance = await assembleContext(db, null, {
  query: '艾拉', chatId: CHAT, characterId: '艾拉', injectStances: false,
});
check('injectStances=false -> 只关立场段, 画像表仍在',
  noStance.tablesEnabled === true && noStance.stancesEnabled === false
  && noStance.text.includes(T.headers.profile) && !noStance.text.includes(T.headers.stances)
  && noStance.stanceCount === 0);

// ===============================================================
console.log('\n--- 查询层口径 (stanceService) ---');
check('chatStances 与 currentStances 口径一致 (chat 过滤)',
  chatStances(db, { chatId: CHAT }).length === currentStances(db, { chatId: CHAT }).length);
check('stanceOverview 现在同时带 holder 与 target 名',
  stanceOverview(db, { holderType: 'person', holderId: alice.id, chatId: CHAT })
    .every((s) => s.holder_name === '艾拉' && s.target_name));
check('被软删的立场不进注入 (生效口径)',
  (() => {
    const id = addStance(db, {
      holderType: 'person', holderId: hero.id, targetType: 'org', targetId: guild.id,
      stanceType: '疏离', intensity: 0.4, chatId: CHAT, importance: 0.6,
    });
    const before = buildStanceTable(db, { chatId: CHAT });
    const removed = softDeleteStance(db, id);
    const after = buildStanceTable(db, { chatId: CHAT });
    return removed && before.text.includes('疏离') && !after.text.includes('疏离')
      && after.count === before.count - 1;
  })());

// ===============================================================
console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
