// 图投影注入段冒烟测试 (T2: 关键实体表 + 事件时间线表 + 检索层行化)
// 运行: node test/timeline.smoke.js
//
// 这个文件存在的理由 (核心命题):
//   用户对压缩的原始诉求是"同一件事不要注入两遍": 同一个人、同一个地点、同一类行为、
//   同一个时间节点, 在注入文本里都只能被描述一次, 其余场合一律用名字引用。
//   四条底线在这里钉死:
//     1) 时间节点是分组锚点: 同一节点的第二行不再复述时间 (时间维度的 L1 归一);
//     2) 实体名互指: 参与者/地点/因果对端全是名字, 不出现裸 id; 同一名实只展开一次速写 (L3);
//     3) 复现计数 ×N 表达"稳定模式", 且不许被单元格截断吃掉 (L2);
//     4) 表格渲染异常时该段跳过, 其余段落与生成本身不受影响 (永远不断供)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import {
  findOrCreatePerson, findOrCreateLocation, findOrCreateOrg,
  findOrCreateTimePoint, createEvent, addEventParticipant, addEventLink,
} from '../src/services/entityService.js';
import { addChunk } from '../src/services/chunkService.js';
import { addStance } from '../src/services/stanceService.js';
import { upsertProfileEntry } from '../src/services/profileService.js';
import { createMemory } from '../src/services/memoryService.js';
import { chatTimeline, keyEntities } from '../src/services/graphService.js';
import {
  createInjectionContext, buildEntityTable, buildTimelineTable,
  entitySketch, eventNote, causalText, timeAnchor,
} from '../src/services/injectionService.js';
import { assembleContext } from '../src/services/retrievalService.js';
import { displayWidth } from '../src/services/tableRender.ts';
import { INJECTION_TABLES } from '../src/domain/constants.js';
import { SYSTEM_PROMPT as EXTRACT_PROMPT } from '../src/services/extractionService.js';
import { EXTRACT_SYSTEM as CHUNK_PROMPT } from '../src/services/chunkExtractionService.js';

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
const TL = T.timeline;
const CHAT = 'chat-tl';

// 固定实体 (findOrCreate* 的返回值: person/location 是对象, createEvent/createChunk 返回 id)
const alice = findOrCreatePerson(db, { name: '艾拉', aliases: ['小艾'], personType: 'npc' });
const hero = findOrCreatePerson(db, { name: '主角', personType: 'main' });
const guild = findOrCreateOrg(db, { name: '档案商会' });
const tavern = findOrCreateLocation(db, { name: '酒馆' });
const archive = findOrCreateLocation(db, { name: '档案馆' });
db.prepare('UPDATE people SET description = ? WHERE id = ?').run('银发档案员, 常年一身墨蓝制服', alice.id);
db.prepare('UPDATE locations SET description = ? WHERE id = ?').run('雨夜壁炉的松木味混着劣质麦酒, 二层隔音差', tavern.id);

// 章节 (第三章) -> 时间节点 (第三夜 #7 / 第四日 #8): parent_id 表达"某夜属于某章"
const chapter = findOrCreateTimePoint(db, { chatId: CHAT, label: '第三章', seq: 6 });
const night = findOrCreateTimePoint(db, { chatId: CHAT, label: '第三夜, 暴雨', seq: 7 });
const day4 = findOrCreateTimePoint(db, { chatId: CHAT, label: '第四日', seq: 8 });
db.prepare('UPDATE time_points SET parent_id = ? WHERE id = ?').run(chapter.id, night.id);

// 事件: 两个挂在同一时间节点 (第三夜), 一个在第四日, 一个无时间节点
const evMeet = createEvent(db, {
  title: '酒馆初遇', process: '为躲雨推门而入, 与独坐角落的陌生人搭话',
  resultText: '两人交换了假名', timeId: night.id, locationId: tavern.id, chatId: CHAT, importance: 0.7,
});
const evTheft = createEvent(db, {
  title: '卷宗失窃', process: '发现编号 Q-17 的卷宗不翼而飞', resultText: '她决定私下追查',
  timeId: night.id, locationId: archive.id, chatId: CHAT, importance: 0.9,
});
const evTalk = createEvent(db, {
  title: '两人对质', causeText: '失窃现场留下了主角的火漆印', resultText: '艾拉半信半疑地放走了主角',
  timeId: day4.id, locationId: archive.id, chatId: CHAT, importance: 0.85,
});
const evMarket = createEvent(db, {
  title: '夜市相遇', timeId: null, locationId: tavern.id, chatId: CHAT, importance: 0.4,
});

addEventParticipant(db, { eventId: evMeet, personId: hero.id, role: '参与者' });
addEventParticipant(db, { eventId: evMeet, personId: alice.id, role: '参与者' });
addEventParticipant(db, { eventId: evTheft, personId: alice.id, role: '发起者' });
addEventParticipant(db, { eventId: evTalk, personId: alice.id, role: '发起者' });
addEventParticipant(db, { eventId: evTalk, personId: hero.id, role: '对象' });

addEventLink(db, { fromId: evMeet, toId: evTalk, relation: 'caused' });
addEventLink(db, { fromId: evTheft, toId: evTalk, relation: 'caused' });
addEventLink(db, { fromId: evMeet, toId: evTheft, relation: 'preceded' });
addEventLink(db, { fromId: evMeet, toId: evMarket, relation: 'contradicts' });

// ===============================================================
console.log('\n--- 时间线取数: 时间节点是排序骨架 ---');
const tl = chatTimeline(db, { chatId: CHAT });
check('取到 4 个事件', tl.length === 4, `len=${tl.length}`);
check('按 (time.seq, id) 正序: 第三夜的两个事件在前, 第四日次之, 无时间节点垫底',
  tl.map((e) => e.title).join(',') === '酒馆初遇,卷宗失窃,两人对质,夜市相遇',
  tl.map((e) => e.title).join(','));
check('章节名随父节点带出 (parent_id 层级)', tl[0].chapterLabel === '第三章', String(tl[0].chapterLabel));
check('参与者解析成人名 (不裸 id), 角色带上',
  tl[2].participants.map((p) => `${p.name}:${p.role}`).join(',') === '主角:对象,艾拉:发起者',
  JSON.stringify(tl[2].participants));
check('因果边方向化: caused 入边 / preceded 入边 / contradicts 双向',
  tl[2].links.filter((l) => l.relation === 'caused').length === 2
  && tl[1].links.some((l) => l.relation === 'preceded')
  && tl[0].links.some((l) => l.relation === 'contradicts'),
  JSON.stringify(tl.map((e) => e.links)));
check('caused 边只在"结果事件"那一行渲染 (同一条边不出现两遍)',
  tl[0].links.every((l) => l.relation !== 'led_to'), JSON.stringify(tl[0].links));

check('limit 取的是"最近的 N 个"而非最早的 N 个',
  chatTimeline(db, { chatId: CHAT, limit: 2 }).map((e) => e.title).join(',') === '两人对质,夜市相遇',
  chatTimeline(db, { chatId: CHAT, limit: 2 }).map((e) => e.title).join(','));
check('另一条聊天取不到本聊天的事件 (时间线按 chat 隔离)',
  chatTimeline(db, { chatId: 'chat-other' }).length === 0);

// ===============================================================
console.log('\n--- 时间线表: 同一时间节点只描述一次 ---');
const ctxA = createInjectionContext();
const tlTable = buildTimelineTable(db, { chatId: CHAT, ctx: ctxA });
const lines = tlTable.text.split('\n');
check('段落标题与常量同源', lines[0] === T.headers.timeline, lines[0]);
check('表头五列: 时间节点 / 事件 / 参与者 / 地点 / 因果标注',
  lines[1].trim().replace(/\s+/g, ' ') === '时间节点 事件 参与者 地点 因果标注', lines[1]);
// 按"事件列"取行 —— 不能只做 includes(标题): 因果列里也会出现别的事件标题
const rowOf = (title) => lines.slice(3)
  .find((l) => (l.split(/ {2,}/)[1] ?? '').trim().startsWith(title)) ?? '';
check('首行带章节前缀 (章节切换处出现一次)',
  rowOf('酒馆初遇').startsWith('第三章') && rowOf('酒馆初遇').includes('#7'),
  JSON.stringify(rowOf('酒馆初遇')));
check('同一时间节点的第二个事件: 时间列留空, 且不再重复章节/时间描述',
  // 该行以列宽等长的空白开头 (时间列留空), 后续列照常对齐
  rowOf('卷宗失窃').startsWith(' ') && !rowOf('卷宗失窃').includes('暴雨'),
  JSON.stringify(rowOf('卷宗失窃')));
check('切换时间节点后锚点重新出现',
  rowOf('两人对质').includes('第四日 #8'), JSON.stringify(rowOf('两人对质')));
check('无时间节点的事件锚点用占位符',
  rowOf('夜市相遇').includes(TL.untimedLabel), JSON.stringify(rowOf('夜市相遇')));
check('事件列带事件性注记 (result_text 优先), 括在常量规定的括号里',
  rowOf('酒馆初遇').includes(`${TL.notePrefix}两人交换了假名${TL.noteSuffix}`), JSON.stringify(rowOf('酒馆初遇')));
check('无 result/process 的事件不打注记', !rowOf('夜市相遇').includes(TL.notePrefix), JSON.stringify(rowOf('夜市相遇')));
check('默认角色不加括号注记, 非默认角色加',
  rowOf('酒馆初遇').includes('主角, 艾拉') && rowOf('卷宗失窃').includes(`艾拉(${'发起者'})`),
  JSON.stringify(rowOf('卷宗失窃')));
check('因果列压成三种前缀 (← 起因 / ⇠ 前承 / ⇄ 矛盾)',
  rowOf('两人对质').includes(`${T.linkLabels.caused}: 酒馆初遇`)
  && rowOf('卷宗失窃').includes(`${T.linkLabels.preceded}: 酒馆初遇`)
  && rowOf('酒馆初遇').includes(`${T.linkLabels.contradicts}: 夜市相遇`),
  JSON.stringify([rowOf('两人对质'), rowOf('卷宗失窃')]));
check('列起点按显示宽度推进 (中文按 2 列对齐)',
  displayWidth(rowOf('酒馆初遇').slice(0, rowOf('酒馆初遇').indexOf('酒馆初遇')))
  === displayWidth(rowOf('卷宗失窃').slice(0, rowOf('卷宗失窃').indexOf('卷宗失窃'))),
  '事件列的起点在两张行里必须相同');
check('空聊天不出段 (连标题都不输出)',
  buildTimelineTable(db, { chatId: 'chat-none' }).text === '');
check('行数上限: 截到 limit 行, total 报未截前的真实条数', (() => {
  const t = buildTimelineTable(db, { chatId: CHAT, limit: 2 });
  return t.count === 2 && t.total === 2;
})(), 'limit 在取数阶段生效 (最近 N 个)');

// 纯格式化函数
check('timeAnchor: 无 time_id 返回占位符', timeAnchor({ timeId: null }) === TL.untimedLabel);
check('时间节点 seq 缺失时不打 # 号',
  timeAnchor({ timeId: 1, timeLabel: '某日', timeSeq: null }) === '某日');
check('eventNote: result_text 优先于 process',
  eventNote({ resultText: '结果', process: '经过' }) === `${TL.notePrefix}结果${TL.noteSuffix}`);
check('eventNote: 两者都空返回空串', eventNote({}) === '');
check('causalText: 未知 relation 忽略, 无标题忽略',
  causalText([{ relation: '???', title: 'X' }, { relation: 'caused', title: '' }]) === '');

// ===============================================================
console.log('\n--- 关键实体表: 节点目录 + 复现计数 ---');
// L2 折叠链: 同一条行为观察被反复看到 3 次 -> 链头链深 3
const c1 = addChunk(db, { entityType: 'person', entityId: alice.id, aspect: 'personality', content: '嘴上嘲讽, 但主角遇险时会下意识挡在前面', chatId: CHAT, importance: 0.7 });
const c2 = addChunk(db, { entityType: 'person', entityId: alice.id, aspect: 'personality', content: '嘴上嘲讽, 但主角遇险时会下意识挡在前面', supersedesChunkId: c1, chatId: CHAT, importance: 0.7 });
addChunk(db, { entityType: 'person', entityId: alice.id, aspect: 'personality', content: '嘴上嘲讽, 但主角遇险时会下意识挡在前面', supersedesChunkId: c2, chatId: CHAT, importance: 0.7 });
// 地点的稳定氛围: description 与链头观察几乎同文 -> 只留一份
addChunk(db, { entityType: 'location', entityId: tavern.id, aspect: 'atmosphere', content: '雨夜壁炉的松木味混着劣质麦酒', chatId: CHAT, importance: 0.6 });

const ents = keyEntities(db, { chatId: CHAT, windowIds: tl.map((e) => e.id) });
check('实体目录按 (引用度数 × importance) 排序: 艾拉(3 次引用) 在酒馆/档案馆之前',
  ents[0].name === '艾拉', ents.map((e) => `${e.name}${e.degree}`).join(' '));
check('度数来自真实事件引用 (person 走 participants, location 走 location_id)',
  ents.find((e) => e.name === '艾拉').degree === 3 && ents.find((e) => e.name === '酒馆').degree === 2,
  JSON.stringify(ents.map((e) => [e.name, e.degree, e.windowDegree])));
check('时间线窗口内的引用额外加权 (窗口 = 全部 4 个事件时, score = 2 × 度数 × importance)',
  Math.abs(ents[0].score - (2 * 3 * 0.7)) < 1e-6, String(ents[0].score));
check('不传窗口时退化为纯度数排序 (score = 度数 × importance)',
  Math.abs(keyEntities(db, { chatId: CHAT })[0].score - (3 * 0.7)) < 1e-6,
  String(keyEntities(db, { chatId: CHAT })[0].score));
check('链头链深 = 3 (L2 折叠: 同一条观察被反复看到 3 次)', ents[0].depth === 3, String(ents[0].depth));
check('链头取的是未被覆盖的那一条 (旧块仍在库里, 不进注入)',
  ents[0].head.id === c2 ? false : ents[0].head.id > c2, String(ents[0].head.id));
check('只出现一次的观察不打 ×N', keyEntities(db, { chatId: CHAT }).find((e) => e.name === '酒馆').depth === 1);
check('度数 0 且无描述无观察的实体不进目录 (噪声节点)',
  !ents.some((e) => e.name === '档案商会'), ents.map((e) => e.name).join(','));

const ctxB = createInjectionContext();
const entTable = buildEntityTable(db, { chatId: CHAT, ctx: ctxB });
const eLines = entTable.text.split('\n');
check('表头四列: 实体 / 类型 / 别名 / 速写',
  eLines[1].trim().replace(/\s+/g, ' ') === '实体 类型 别名 速写', eLines[1]);
check('类型渲染成中文标签 (查常量, 不写字面量)',
  eLines[3].includes(T.entities.kindLabels.person), eLines[3]);
check('别名列解析 JSON 数组; 无别名给占位符',
  eLines[3].includes('小艾') && eLines.some((l) => l.includes(T.entities.noAlias)), JSON.stringify(eLines.slice(3)));
check('复现计数 ×3 出现在速写列', eLines[3].includes(`${T.recurrenceMark}3`), eLines[3]);
check('×N 不会被单元格截断吃掉 (速写总宽度 ≤ 单元格上限)',
  displayWidth(eLines[3].split(/ {2,}/).pop()) <= T.limits.cellMaxWidth, String(displayWidth(eLines[3].split(/ {2,}/).pop())));
check('description 与链头观察互相覆盖时只留一份 (不把压缩又花回去)',
  entitySketch({ description: '雨夜松木味混麦酒', head: { content: '雨夜松木味混麦酒' }, depth: 1 }).split(T.entities.sketchSep).length === 1,
  entitySketch({ description: '雨夜松木味混麦酒', head: { content: '雨夜松木味混麦酒' }, depth: 1 }));
check('description 与链头是不同信息时两者都保留',
  entitySketch({ description: '银发档案员', head: { content: '嘴上嘲讽遇险护人' }, depth: 1 })
    === `银发档案员${T.entities.sketchSep}嘴上嘲讽遇险护人`);
check('行数上限 entityRows 生效', buildEntityTable(db, { chatId: CHAT, limit: 2 }).count === 2);
check('实体表为空时不出段 (另一条聊天没有本聊天的节点)', buildEntityTable(db, { chatId: 'chat-none' }).text === '');

// ===============================================================
console.log('\n--- L3 首现展开: 同一名实一次注入只全量描述一次 ---');
const ctxEarly = createInjectionContext();
const tlEarly = buildTimelineTable(db, { chatId: CHAT, ctx: ctxEarly, sketches: new Map([['艾拉', '银发档案员']]) });
check('实体表未覆盖时: 时间线里首现就地展开短速写',
  tlEarly.text.includes('艾拉(银发档案员)'), JSON.stringify(tlEarly.text.split('\n').find((l) => l.includes('酒馆初遇'))));
const ctxLate = createInjectionContext();
const entLate = buildEntityTable(db, { chatId: CHAT, ctx: ctxLate });
const tlLate = buildTimelineTable(db, { chatId: CHAT, ctx: ctxLate, sketches: entLate.sketches });
check('实体表已覆盖时: 时间线里的同名人只出现纯名字 (不重复速写)',
  tlLate.text.includes('艾拉') && !tlLate.text.includes('艾拉(银发'), JSON.stringify(tlLate.text.split('\n').find((l) => l.includes('酒馆初遇'))));
const ctxTrunc = createInjectionContext();
const tlTrunc = buildTimelineTable(db, { chatId: CHAT, ctx: ctxTrunc, sketches: new Map([['艾拉', '一二三四五六七八九十十一十二十三']]) });
check('首现展开受限速写上限 (sketchMaxWidth): 超长速写按显示宽截断',
  /艾拉\(.+…\)/.test(tlTrunc.text) && !tlTrunc.text.includes('十二'), JSON.stringify(tlTrunc.text.split('\n').find((l) => l.includes('酒馆初遇'))));

// ===============================================================
console.log('\n--- 检索层行化 + 预算 + 跨段去重 ---');
createMemory(db, { type: 'fact', content: '主角是左撇子', keywords: '主角 左撇子', scope: 'chat', chatId: CHAT, importance: 0.8 });
createMemory(db, {
  type: 'summary', content: '主角与艾拉在酒馆相识, 卷宗随后失窃',
  scope: 'chat', chatId: CHAT, sourceMessageIds: [4, 9], importance: 0.7,
});
upsertProfileEntry(db, { characterId: '艾拉', category: 'appearance', key: '发色', value: '银白, 及腰' });
addStance(db, {
  holderType: 'person', holderId: alice.id, targetType: 'person', targetId: hero.id,
  stanceType: '戒备', intensity: 0.5, chatId: CHAT, importance: 0.8,
});

// 观察块: 一条内容与实体表速写相同 (应被跨段去重), 一条是新信息 (应保留)
const qvec = new Float32Array([1, 0, 0]);
addChunk(db, { entityType: 'person', entityId: alice.id, aspect: 'habit', content: '嘴上嘲讽, 但主角遇险时会下意识挡在前面', embeddingVec: qvec, embeddingModel: 'mock', chatId: CHAT, importance: 0.9 });
addChunk(db, { entityType: 'person', entityId: alice.id, aspect: 'speech', content: '说话时习惯用短句, 尾音很轻', embeddingVec: qvec, embeddingModel: 'mock', chatId: CHAT, importance: 0.6 });
const mockEmbed = { model: 'mock', embed: async (texts) => texts.map(() => qvec) };

const ctxTables = await assembleContext(db, mockEmbed, { query: '主角 左撇子', chatId: CHAT, characterId: '艾拉' });
check('表格化形态下 section 顺序: 画像 → 立场 → 关键实体 → 前情提要 → 时间线 → 相关记忆 → 相关细节',
  (() => {
    const order = ['角色画像', '关系立场', '关键实体', '前情提要', '事件时间线', '相关记忆', '相关细节']
      .map((label) => ctxTables.text.indexOf(`【${label}】`));
    return order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]);
  })(),
  ['角色画像', '关系立场', '关键实体', '前情提要', '事件时间线', '相关记忆', '相关细节'].map((l) => `${l}:${ctxTables.text.indexOf(`【${l}】`)}`).join(' '));
check('检索段行化为 markdown 管道行 (不对齐、无分隔行)',
  /\| 类型 \| 剧情时间 \| 内容 \| 楼层 \|/.test(ctxTables.text)
  && !/\|\s*-{3,}/.test(ctxTables.text),
  ctxTables.text.split('\n').filter((l) => l.startsWith('|')).join(' / '));
check('相关细节段有实体名/维度/观察三列',
  /\| 实体 \| 维度 \| 观察 \|/.test(ctxTables.text),
  ctxTables.text.split('\n').filter((l) => l.startsWith('|')).join(' / '));
check('跨段去重: 与实体表速写同源的观察块不进相关细节 (按块 id 判重)', ctxTables.chunkDeduped >= 1, String(ctxTables.chunkDeduped));
check('跨段去重不误伤新信息 (新观察照常渲染)', ctxTables.text.includes('尾音很轻'), ctxTables.text);
check('实体目录按聊天隔离: 只在本聊天出场过的节点才进注入',
  !ctxTables.text.includes('档案商会'), '仅在库中存在 description 的实体不该凭空出现');
check('检索段仍共享 tokenBudget, 常驻段不占 (usedTokens 只算检索段)',
  ctxTables.usedTokens <= ctxTables.tokenBudget && ctxTables.entityTokens > 0 && ctxTables.timelineTokens > 0,
  JSON.stringify({ used: ctxTables.usedTokens, budget: ctxTables.tokenBudget }));
check('统计字段齐备 (实体/时间线/形态)', ctxTables.entityCount >= 3 && ctxTables.timelineCount === 4 && ctxTables.injectionMode === 'tables',
  JSON.stringify({ e: ctxTables.entityCount, t: ctxTables.timelineCount, m: ctxTables.injectionMode }));

const ctxSmall = await assembleContext(db, mockEmbed, { query: '主角 左撇子', chatId: CHAT, tokenBudget: 1 });
check('检索预算极小: 检索段退化为空, 但常驻段照常 (常驻不吃检索预算)',
  ctxSmall.usedTokens === 0 && ctxSmall.hitCount === 0
  && ctxSmall.text.includes(T.headers.timeline) && !ctxSmall.text.includes(T.headers.memories),
  JSON.stringify({ used: ctxSmall.usedTokens, hits: ctxSmall.hitCount }));

const ctxBullets = await assembleContext(db, mockEmbed, { query: '主角 左撇子', chatId: CHAT, characterId: '艾拉', injectTables: false });
check('injectTables=false: 回到全量 bullet 路径 (无损可逆)', ctxBullets.injectionMode === 'bullets'
  && ctxBullets.text.includes('- [') && !ctxBullets.text.includes('| 类型 |'),
  ctxBullets.text.slice(0, 200));
check('关掉表格后不再出现关键实体/时间线段 (它们本来就是表格段)',
  !ctxBullets.text.includes(T.headers.entities) && !ctxBullets.text.includes(T.headers.timeline));

// ===============================================================
console.log('\n--- 抽取层 prompt 约束 (压缩要在入库时就做, 渲染层救不回来) ---');
check('要素抽取 prompt 含信息正交性条款 (事件正文禁止写时间/人物/地点)',
  EXTRACT_PROMPT.includes('信息正交性') && EXTRACT_PROMPT.includes('禁止写入时间、人物名、地点'), '');
check('要素抽取 prompt 含琐事排除条款 (日常重复行为不建事件)',
  EXTRACT_PROMPT.includes('不要建事件') && EXTRACT_PROMPT.includes('琐事'), '');
check('属性抽取 prompt 含 habit 归类条款 (重复日常归行为观察)',
  CHUNK_PROMPT.includes('habit') && CHUNK_PROMPT.includes('稳定行为模式'), '');
check('属性抽取 prompt 要求原样重复抽取 (折叠交给写入管线, 不自己合并)',
  CHUNK_PROMPT.includes('照原样抽出来'), '');

console.log('');
if (failures === 0) console.log('全部通过');
else { console.error(`${failures} 项失败`); process.exitCode = 1; }
