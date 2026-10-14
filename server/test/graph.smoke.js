// 记忆网络图投影 (graphProjection) 冒烟测试 —— 可视化窗口 GET /graph 的数据源。
//
// 钉住的是 docs/graph-view.md §8 的不变式 (每条都对应一个"图打开一看就该是这样"的常识):
//   1) 线上零句子 —— 边标签只有抽象词, 绝不出现拼接签名 (旧版 `label · 谓词 · 时间 ×N`)
//   2) 语义不缺   —— 每个实例恰好一条谓词边 + 一条真值边; 有时间锚的必有一条时间边
//   3) 抽象层可复用 —— 词表节点只收用过的词, id 落在 constants 词表内, count 累加正确
//   4) 实例唯一   —— order 连续、coordinate 在同一时间节点内唯一
//   5) 边界与隔离 —— 未被边引用的实体不进图; chatId 过滤隔离会话
//   6) 锚点可回溯 —— 立场/观察/持有者都指向本图内的实例
// 运行: node test/graph.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import {
  findOrCreatePerson, findOrCreateLocation, findOrCreateTimePoint,
  createEvent, addEventParticipant, addEventLink,
} from '../src/services/entityService.js';
import { addStance } from '../src/services/stanceService.js';
import { projectGraph, listChats } from '../src/services/graphProjection.js';
import { VERB_LAYER, INJECTION_TABLES } from '../src/domain/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

const freshDb = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(projectRoot, 'db'), () => {});
  return db;
};

const db = freshDb();
const CHAT = 'graph-test';
// ---- 搭一场小戏: 你(主角) 与 守卫 在国门, 两个实例带因果, 一个归属从句, 一条立场, 一条观察 ----
const you = findOrCreatePerson(db, { name: '你', personType: 'main' });
const guard = findOrCreatePerson(db, { name: '守卫', personType: 'npc' });
const passerby = findOrCreatePerson(db, { name: '路人甲', personType: 'mentioned' }); // 故意不被引用
const gate = findOrCreateLocation(db, { name: '国门' });
const ch1 = findOrCreateTimePoint(db, { chatId: CHAT, label: '第一章', seq: 1 });
const night = findOrCreateTimePoint(db, { chatId: CHAT, label: '第三夜, 暴雨', seq: 2 });
db.prepare('UPDATE time_points SET parent_id = ? WHERE id = ?').run(ch1.id, night.id);

const e1 = createEvent(db, {
  chatId: CHAT, title: '旅人抵达国门', label: 'e1', verbType: '去', verbSurface: '赶来',
  timeId: night.id, locationId: gate.id, sourceType: 'narrator', status: 'asserted',
});
const e2 = createEvent(db, {
  chatId: CHAT, title: '守卫拦下旅人盘查', label: 'e2', verbType: '问', verbSurface: '盘问',
  timeId: night.id, sourceType: 'narrator', status: 'asserted',
});
// 归属从句: "守卫说他去买草药" —— 真值不归叙述者 (docs/verb-layer.md §4.4)
const e3 = createEvent(db, {
  chatId: CHAT, title: '去买草药', label: 'e3', verbType: '去', verbSurface: '去买',
  sourceType: 'attributed', sourcePersonId: guard.id, attitude: '说',
  status: 'pending', parentInstanceId: e2, parentRole: 'comp',
});
addEventParticipant(db, { eventId: e1, personId: you.id, role: '发起者' });
addEventParticipant(db, { eventId: e2, personId: you.id, role: '对象' });
addEventParticipant(db, { eventId: e2, personId: guard.id, role: '发起者' });
addEventParticipant(db, { eventId: e3, personId: guard.id, role: '发起者' });
// 词表外的情态词 (自由字符串): 必须原样保留成待审元素, 不能被兜底糊成同一个"声称"
// (注: '威胁' 现在已是 '说' 的别名 —— 它会归一到 说, 那属于归一, 不是这里要测的路径)
const e4 = createEvent(db, {
  chatId: CHAT, title: '不祥的预感', label: 'e4', verbType: '发现',
  sourceType: 'attributed', sourcePersonId: guard.id, attitude: '预感', status: 'pending',
});
addEventParticipant(db, { eventId: e4, personId: guard.id, role: '发起者' });
addEventLink(db, { fromId: e1, toId: e2, relation: 'caused' });
const st = addStance(db, {
  holderType: 'person', holderId: guard.id, targetType: 'person', targetId: you.id,
  stanceType: '戒备', intensity: 0.8, basis: '盘查来路', chatId: CHAT, validFromEventId: e2,
});
db.prepare(`INSERT INTO attribute_chunks
  (entity_type, entity_id, aspect, content, valid_from_event_id, chat_id, source_message_ids, importance, is_active, created_at, updated_at)
  VALUES ('person', ?, 'habit', '盘查时先给三次机会', ?, ?, '["floor-1"]', 0.6, 1, strftime('%s','now'), strftime('%s','now'))`)
  .run(guard.id, e2, CHAT);
// 第二个聊天: 验证 chatId 过滤 (createEvent 返回的是 id 数字, 不是行对象)
const eOther = createEvent(db, { chatId: 'other-chat', title: '别处的事', verbType: '去' });
const other = findOrCreatePerson(db, { name: '别人', personType: 'npc' });
addEventParticipant(db, { eventId: eOther, personId: other.id });

const g = projectGraph(db, { chatId: CHAT });
const evIds = new Set(g.nodes.instances.map((e) => e.id));
check('投影带图式版本号 (静态页据此拒绝旧服务端的空图)', g.schema === 'graph-view/v2', String(g.schema));

// ---------- 1) 线上零句子 ----------
console.log('\n--- 1) 线上零句子: 边标签只有抽象词 ---');
{
  const SIG = /[·×\n\r]/;                        // 旧版拼接签名的分隔符与计数后缀
  const words = [];
  for (const e of g.edges.roles) words.push(['角色', e.label]);
  for (const e of g.edges.holders) words.push(['持有者', e.label]);
  for (const e of g.edges.links) words.push(['关系', e.label]);
  for (const e of g.edges.nesting) words.push(['嵌套', e.label]);
  for (const e of g.edges.stances) words.push(['立场', e.stanceType]);
  for (const e of g.edges.observations) words.push(['方面', e.aspect]);
  check('边标签非空且无签名分隔符/计数后缀',
    words.length > 0 && words.every(([, w]) => w && !SIG.test(w)),
    JSON.stringify(words.filter(([, w]) => !w || SIG.test(w))));

  const roleVals = new Set(VERB_LAYER.thematicRoles.map((r) => r.value));
  check('角色边一律是题元角色词 (或用自由词, 但必须是单段)',
    g.edges.roles.every((e) => e.label === e.role && !/\s/.test(e.role)),
    JSON.stringify(g.edges.roles.map((e) => e.role)));
  check('角色边落在题元角色词表内 (发起者/对象)',
    g.edges.roles.every((e) => roleVals.has(e.role)), JSON.stringify(g.edges.roles.map((e) => e.role)));
  check('关系边的词取自 constants.linkLabels',
    g.edges.links.every((e) => e.label === INJECTION_TABLES.linkLabels[e.relation]),
    JSON.stringify(g.edges.links));
  check('嵌套边的词取自 constants.parentRoles',
    g.edges.nesting.every((e) => VERB_LAYER.parentRoles.some((r) => r.value === e.role)),
    JSON.stringify(g.edges.nesting));
  check('边上只有短词: 句子载荷 (title/process/resultText) 只留在实例上',
    [...g.edges.roles, ...g.edges.holders, ...g.edges.links, ...g.edges.nesting]
      .every((e) => !e.label || e.label.length <= 12)
    && g.nodes.instances.every((e) => typeof e.title === 'string' && typeof e.process === 'string'));
  check('旧版"签名束"字段 (sig/sigs) 已从投影里消失',
    !JSON.stringify(g.edges).includes('"sig"'));
}

// ---------- 2) 语义不缺 ----------
console.log('\n--- 2) 语义不缺: 谓词/真值/时间一个不少 ---');
{
  const one = (arr, key, id) => arr.filter((e) => e[key] === id).length;
  check('每个实例恰好一条谓词边',
    g.nodes.instances.every((e) => one(g.edges.predicates, 'instance', e.id) === 1));
  check('每个实例恰好一条真值边',
    g.nodes.instances.every((e) => one(g.edges.truths, 'instance', e.id) === 1));
  check('每个实例恰好一条情态边',
    g.nodes.instances.every((e) => one(g.edges.modalities, 'instance', e.id) === 1));
  check('有时间锚的实例必有一条时间边',
    g.nodes.instances.every((e) => (e.timeId == null) === (one(g.edges.times, 'instance', e.id) === 0)));
  check('谓词缺省不致实例消失 (空 verb_type -> 未归一 占位)',
    g.nodes.instances.every((e) => !!e.predicate && (e.predicate !== '未归一' || e.predicateUnknown)));
  check('极点/时态/状态如实透传',
    g.nodes.instances.every((e) => ['+', '-'].includes(e.polarity) && ['past', 'now', 'future'].includes(e.tense)));
}

// ---------- 3) 抽象层可复用 ----------
console.log('\n--- 3) 抽象层: 词表节点只收用过的词, 且真的被复用 ---');
{
  const preds = new Set(g.nodes.instances.map((e) => e.predicate));
  check('谓词节点 = 实例谓词集合',
    g.nodes.predicates.length === preds.size && g.nodes.predicates.every((p) => preds.has(p.id)),
    JSON.stringify(g.nodes.predicates));
  check('谓词节点带复用度 count 与原文 surface',
    g.nodes.predicates.find((p) => p.id === '去')?.count === 2
    && g.nodes.predicates.find((p) => p.id === '去')?.surfaces.includes('赶来'),
    JSON.stringify(g.nodes.predicates));
  check('真值节点 id 落在 constants.statuses, 标签用 short',
    g.nodes.truths.every((t) => VERB_LAYER.statuses.some((s) => s.value === t.id) && t.label)
    && g.nodes.truths.find((t) => t.id === 'pending')?.label === '未决',
    JSON.stringify(g.nodes.truths));
  check('真值节点 count 之和 = 实例数',
    g.nodes.truths.reduce((n, t) => n + t.count, 0) === g.nodes.instances.length);
  check('情态节点: 叙述者断言 + 归属情态(说) + 词表外的自由词原样保留 (预感)',
    g.nodes.modalities.some((m) => m.id === 'narrator')
    && g.nodes.modalities.some((m) => m.id === 'attitude:说' && m.label === '说')
    && g.nodes.modalities.some((m) => m.id === 'attitude:预感' && m.label === '预感'),
    JSON.stringify(g.nodes.modalities));
  check('角色节点 count 之和 = 参与边数',
    g.nodes.roles.reduce((n, r) => n + r.count, 0) === g.edges.roles.length);
  check('时间节点带复用度 (第三夜被两个实例引用)',
    g.nodes.timePoints.find((t) => t.label === '第三夜, 暴雨')?.count === 2,
    JSON.stringify(g.nodes.timePoints));
}

// ---------- 4) 实例唯一 ----------
console.log('\n--- 4) 实例唯一: order 与坐标 ---');
{
  const orders = g.nodes.instances.map((e) => e.order);
  check('order 从 1 连续递增', JSON.stringify(orders) === '[1,2,3,4]', JSON.stringify(orders));
  const coords = g.nodes.instances.map((e) => e.coordinate);
  check('coordinate 唯一且形如 #seq.k',
    new Set(coords).size === coords.length && coords.every((c) => /^#\d+\.\d+$/.test(c)), JSON.stringify(coords));
  check('同一时间节点内 k 递增 (第三夜有两条实例)', coords.includes('#2.1') && coords.includes('#2.2'), JSON.stringify(coords));
  check('无时间锚的实例坐标落在 0 段', g.nodes.instances.find((e) => e.timeId == null)?.coordinate.startsWith('#0.'));
}

// ---------- 5) 边界与隔离 ----------
console.log('\n--- 5) 实体边界与 chatId 隔离 ---');
{
  const names = g.nodes.people.map((p) => p.name).sort();
  check('参与 + 持仓有者引用的人都进图',
    JSON.stringify(names) === JSON.stringify(['你', '守卫']), JSON.stringify(names));
  check('未被任何边引用的实体不进图 (路人甲)', !g.nodes.people.some((p) => p.name === '路人甲'));
  check('main 类型如实透传', g.nodes.people.find((p) => p.name === '你')?.type === 'main');
  check('实例位置边把地点带进图', g.nodes.locations.some((l) => l.name === '国门'));
  check('别的聊天的实例不进来', !evIds.has(eOther));
  const all = projectGraph(db, {});
  check('chatId 缺省 = 全部', all.nodes.instances.length === 5, String(all.nodes.instances.length));
  check('全图时其他聊天的人物也进图', all.nodes.people.some((p) => p.name === '别人'));
  check('chats 清单包含两个聊天且按实例数排序',
    g.chats[0].chatId === CHAT && g.chats.length === 2, JSON.stringify(g.chats));
  // 时间嵌套: 第三夜 属于 第一章
  check('时间节点可嵌套 (第三夜 -> 第一章)',
    g.edges.timeParents.some((p) => p.parent === ch1.id && p.child === night.id),
    JSON.stringify(g.edges.timeParents));
}

// ---------- 6) 锚点可回溯 ----------
console.log('\n--- 6) 锚点可回溯: 立场/观察/归属 ---');
{
  const s = g.edges.stances[0];
  check('立场边: 守卫 → 你 / 戒备 / 0.8',
    s.holderId === guard.id && s.targetId === you.id && s.stanceType === '戒备' && s.intensity === 0.8,
    JSON.stringify(s));
  check('立场锚到触发实例且在本图内', s.fromEvent === e2 && evIds.has(s.fromEvent));
  db.prepare('UPDATE stances SET is_active = 0 WHERE id = ?').run(st);
  check('只取当前生效立场', projectGraph(db, { chatId: CHAT }).edges.stances.length === 0);
  db.prepare('UPDATE stances SET is_active = 1 WHERE id = ?').run(st);

  check('观察边挂在 valid_from_event_id 指向的实例上',
    g.edges.observations.length === 1 && g.edges.observations[0].instance === e2
    && g.edges.observations[0].aspect === 'habit', JSON.stringify(g.edges.observations));
  check('观察锚点在本图内', g.edges.observations.every((o) => evIds.has(o.instance)));
  const noObs = projectGraph(db, { chatId: CHAT, withObservations: false });
  check('withObservations=false 时不出现观察边', noObs.edges.observations.length === 0);
  check('关观察层不影响其余层', noObs.edges.roles.length === 5 && noObs.edges.links.length === 1,
    `${noObs.edges.roles.length}/${noObs.edges.links.length}`);

  check('归属命题带持有者边 (谁说的)',
    g.edges.holders.some((h) => h.instance === e3 && h.entity === guard.id && h.label === '持有者'),
    JSON.stringify(g.edges.holders));
  check('嵌套引述成边: 宿主 e2 --命题宾语--> 从句 e3',
    g.edges.nesting.some((n) => n.parent === e2 && n.child === e3 && n.role === 'comp'),
    JSON.stringify(g.edges.nesting));
  check('因果边带抽象词', g.edges.links[0].label === INJECTION_TABLES.linkLabels.caused, JSON.stringify(g.edges.links));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
