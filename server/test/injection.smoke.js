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
import { findOrCreatePerson, findOrCreateOrg, findOrCreateLocation, findOrCreateTimePoint, createEvent, addEventParticipant } from '../src/services/entityService.js';
import { addStance, currentStances, chatStances, stanceOverview, softDeleteStance, applyStance } from '../src/services/stanceService.js';
import { buildProfileTable, buildStanceTable, buildTimelineTable, buildPendingSection, eventText, createInjectionContext, intensityLabel, stanceDisplayText } from '../src/services/injectionService.js';
import { assembleContext } from '../src/services/retrievalService.js';
import { createMemory } from '../src/services/memoryService.js';
import { INJECTION_TABLES } from '../src/domain/constants.js';
import { formatStamp } from '../src/utils/time.js';

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

// ---- V10 时间戳: 时间位置只放精确时间, 不留任何模糊措辞 ----
check('【当前时间】段排在最前 (时间锚)', ctx.text.startsWith(T.headers.clock), ctx.text.slice(0, 60));
check('时间锚精确到分且带星期 (年月日星期时分)',
  /^【当前时间】\d{4}年\d{2}月\d{2}日星期. \d{2}:\d{2}$/.test(ctx.text.split('\n')[0]),
  ctx.text.split('\n')[0]);
check('时间锚不带任何模糊措辞 (没有"约/推断/未定时")',
  !/约|推断|未定时/.test(ctx.text.split('\n')[0]), ctx.text.split('\n')[0]);
check('时间锚 = 最近一条记录的写入时间 (不是服务端当前时间)',
  ctx.clockAt === db.prepare('SELECT MAX(created_at) m FROM memories WHERE chat_id = ?').get(CHAT).m
  && ctx.clockInferred === true,
  String(ctx.clockAt));
// 把记录时间改到固定值: 锚点必须跟着动 (证明它真的取自记录, 而不是读表时的 now)
const FIXED_TS = Math.floor(Date.UTC(2026, 9, 15, 1, 23) / 1000);
db.prepare('UPDATE memories SET created_at = ? WHERE chat_id = ?').run(FIXED_TS, CHAT);
const ctxClock = await assembleContext(db, null, { query: '艾拉', chatId: CHAT, characterId: '艾拉' });
check('改记录时间, 时间锚随之改变 (取自记录, 不是读表时的 now)',
  ctxClock.clockAt === FIXED_TS && ctxClock.text.includes(formatStamp(FIXED_TS)),
  `at=${ctxClock.clockAt} want=${formatStamp(FIXED_TS)}`);
const ctxFresh = await assembleContext(db, null, { query: '艾拉', chatId: 'chat-没有任何记录' });
check('库里一条记录都没有 => 退回服务端当前时间 (字段如实上报来源, prompt 里不写)',
  ctxFresh.clockInferred === false
  && /^【当前时间】\d{4}年\d{2}月\d{2}日星期. \d{2}:\d{2}$/.test(ctxFresh.text.split('\n')[0]),
  ctxFresh.text.split('\n')[0]);
// 全局不变量在待兑现段之后统一断言 (那里才有带剧情时间标签的实例, 见下文)

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
console.log('\n--- V6: 时间线内联归属声称 (带来源口吻) + 【待兑现】段 ---');
const day = findOrCreateTimePoint(db, { chatId: CHAT, label: '第九夜', seq: 9 });
const hero2 = findOrCreatePerson(db, { name: '信使' });

// (a) 一条"已被拆穿的声称": 以来源口吻出现在时间线上, 带定局标记
const claim = createEvent(db, {
  title: '信使的说辞', chatId: CHAT, verbType: '说', verbSurface: '声称',
  sourceType: 'attributed', attitude: '说', sourcePersonId: hero2.id,
  status: 'refuted', tense: 'past', timeId: day.id, importance: 0.8,
});
addEventParticipant(db, { eventId: claim, personId: hero2.id, role: '发起者' });
createEvent(db, {
  title: '卷宗已送往王都', chatId: CHAT, verbType: '送',
  parentInstanceId: claim, parentRole: 'comp', sourceType: 'attributed',
  status: 'refuted', tense: 'past', importance: 0.5,
});

// (b) 一条未决承诺: 进【待兑现】, 不进时间线
const promise = createEvent(db, {
  title: '答应带路', chatId: CHAT, verbType: '承诺', verbSurface: '答应',
  sourceType: 'attributed', attitude: '说', sourcePersonId: hero2.id,
  status: 'pending', tense: 'future', timeId: day.id, importance: 0.7,
});
addEventParticipant(db, { eventId: promise, personId: hero2.id, role: '发起者' });
createEvent(db, {
  title: '带主角去北门', chatId: CHAT, verbType: '去',
  parentInstanceId: promise, parentRole: 'comp', sourceType: 'attributed',
  status: 'pending', tense: 'future', importance: 0.5,
});

const tl = buildTimelineTable(db, { chatId: CHAT, ctx: createInjectionContext() });
check('时间线收已拆穿的声称, 并以来源口吻 + 定局标记渲染',
  tl.text.includes('信使说：卷宗已送往王都（已被拆穿）'), tl.text);
check('未决承诺不进时间线', !tl.text.includes('答应带路') && !tl.text.includes('带主角去北门'));

const pend = buildPendingSection(db, { chatId: CHAT });
const P = T.pendingSection;
check('【待兑现】段出现且标题与常量同源', pend.text.startsWith(P.header), pend.text);
check('未决行带持有者与从句内容', pend.text.includes('信使说：带主角去北门'), pend.text);
check('未决行的时间锚是精确时间戳 (不是"第九夜"这类剧情标签)',
  pend.text.includes('（未决 · ') && /\d{4}年\d{2}月\d{2}日星期. \d{2}:\d{2}/.test(pend.text)
  && !pend.text.includes('第九夜'),
  pend.text);

const ctxWithPending = await assembleContext(db, null, { query: '信使', chatId: CHAT, characterId: '艾拉' });
// 全局不变量: 整段上下文里不许出现剧情内时间标签 (它们在库里与图页面上保留, 只是不进 prompt)
check('上下文里没有任何剧情内时间标签 (夜里/第三夜/第九夜/未定时…)',
  !/夜里|夜色|暮色|第三夜|第九夜|未定时/.test(ctxWithPending.text),
  ctxWithPending.text.replace(/\n/g, '⏎').slice(0, 220));
check('assembleContext 注入【待兑现】段并上报统计',
  ctxWithPending.text.includes(P.header) && ctxWithPending.pendingCount >= 1
  && ctxWithPending.pendingTokens > 0,
  JSON.stringify({ c: ctxWithPending.pendingCount, t: ctxWithPending.pendingTokens }));
check('段落顺序: 时间线 → 待兑现 → 检索段',
  ctxWithPending.text.indexOf(T.headers.timeline) < ctxWithPending.text.indexOf(P.header)
  && (ctxWithPending.text.indexOf(T.headers.memories) === -1
    || ctxWithPending.text.indexOf(P.header) < ctxWithPending.text.indexOf(T.headers.memories)),
  ctxWithPending.text.slice(0, 40));
check('待兑现不吃检索预算 (usedTokens 只算记忆与细节)',
  ctxWithPending.usedTokens === (await assembleContext(db, null, { query: '信使', chatId: CHAT })).usedTokens);
check('无未决项的聊天不出【待兑现】段 (空段不出段)',
  buildPendingSection(db, { chatId: 'chat-空' }).text === '');

// 来源口吻的口径: 情态缺失时用兜底话术, 叙述者事实不套口吻
check('叙述者事实不套"某人说"的口吻',
  eventText({ title: '抵达北门', isProposition: false, resultText: '城门开了' }) === '抵达北门 〔城门开了〕');
check('归属声称无情态时用兜底口吻',
  eventText({ title: 'x', isProposition: true, holderName: '信使', attitude: null, comp: { title: '去北门' }, status: 'pending' })
    .startsWith('信使声称：去北门'), '');

// ===============================================================
console.log('\n--- V7: 槽位模型 —— 立场列显示演化链 (值变过才显示) ---');
const v7alice = findOrCreatePerson(db, { name: 'V7甲' });
const v7bob = findOrCreatePerson(db, { name: 'V7乙' });
addStance(db, {
  holderType: 'person', holderId: v7alice.id, targetType: 'person', targetId: v7bob.id,
  stanceType: '戒备', intensity: 0.6, basis: '初遇', chatId: CHAT,
});
const v7migrated = applyStance(db, {
  holderType: 'person', holderId: v7alice.id, targetType: 'person', targetId: v7bob.id,
  stanceType: '信任', intensity: 0.7, basis: '共患难后', chatId: CHAT,
});
check('同槽位再写不同值 => 迁移', v7migrated.operation === 'migrate', v7migrated.operation);
const v7table = buildStanceTable(db, { chatId: CHAT });
const V = T.stanceDisplay;
check('演化链由 constants 的分隔符串成 (戒备 → 信任)',
  v7table.text.includes(`戒备${V.evolutionSep}信任`), v7table.text);
check('未变过的立场不显示演化 (仍是纯值)',
  buildStanceTable(db, { chatId: CHAT }).text.includes('亲疏') === false);
check('上报演化条数 (供面板显示"其中演化 n")',
  v7table.evolvedCount >= 1, String(v7table.evolvedCount));

const ctxEvolved = await assembleContext(db, null, { query: '', chatId: CHAT, characterId: '艾拉' });
check('assembleContext 上报 evolvedStanceCount',
  ctxEvolved.evolvedStanceCount >= 1, String(ctxEvolved.evolvedStanceCount));

// ===============================================================
console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
