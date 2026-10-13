// 命题层冒烟测试 (V6, docs/verb-layer.md §6): 对齐的每条终态 + 事实层视图隔离
// 运行: node test/propositions.smoke.js
//
// 本套钉住对齐的**每一条出口** (这是"承诺未兑现"与"谎话被拆穿"两种叙事张力的机制):
//   realized  兑现 / 证实         refuted  被推翻 / 撒谎记错
//   failed    到点落空            inactive 条件未成立
//   voided    择一未选中
// 外加两条最容易出错的边界:
//   ① 宁缺勿错 (题元重叠不够就保持未决, 绝不"差不多就算兑现");
//   ② 有未决从句的命题自己不参与匹配 (否则"说"这类低特异性动词会泛匹配)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import {
  findOrCreatePerson, findOrCreateTimePoint, createEvent, addEventParticipant, addEventLink,
} from '../src/services/entityService.js';
import { alignPropositions, matchScore } from '../src/services/alignmentService.js';
import { chatTimeline, keyEntities, chatPending } from '../src/services/graphService.js';
import { VERB_LAYER } from '../src/domain/constants.js';

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

const CHAT = 'chat-p';
const person = (name) => findOrCreatePerson(db, { name }).id;

/** 造一条实例 (事实或命题) */
function inst({
  title, verbType, participants = [], locationId = null, timeId = null,
  sourceType = 'narrator', status = 'asserted', tense = 'past', polarity = '+',
  sourceName = null, parent = null, role = null, chatId = CHAT,
}) {
  const id = createEvent(db, {
    title, chatId, verbType, verbSurface: verbType,
    polarity, sourceType, attitude: sourceType === 'attributed' ? '说' : null,
    sourcePersonId: sourceName ? person(sourceName) : null,
    tense, status, timeId, locationId,
    parentInstanceId: parent?.id ?? null, parentRole: role,
  });
  for (const [name, r] of participants) addEventParticipant(db, { eventId: id, personId: person(name), role: r });
  return { id, title, ...parent ? {} : {} };
}

const day1 = findOrCreateTimePoint(db, { chatId: CHAT, label: '第一天', seq: 1 });
const day2 = findOrCreateTimePoint(db, { chatId: CHAT, label: '第二天', seq: 2 });
const statusOf = (id) => db.prepare('SELECT status, aligned_instance_id FROM events WHERE id = ?').get(id);

console.log('\n--- ① 兑现: 未来命题到点匹配到事实 ---');
const promise = inst({
  title: '答应去买', verbType: '去', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', tense: 'future', timeId: day1.id, sourceName: '艾拉',
});
const went = inst({ title: '她去了镇上', verbType: '去', participants: [['艾拉', '发起者']], timeId: day2.id });
let r = alignPropositions(db, { chatId: CHAT });
check('命题转为 realized 并挂上事实指针',
  statusOf(promise.id).status === 'realized' && statusOf(promise.id).aligned_instance_id === went.id,
  JSON.stringify(statusOf(promise.id)));
check('摘要如实上报', r.realized.some((x) => x.id === promise.id), JSON.stringify(r.realized));

console.log('\n--- ② 被推翻: ¬P 匹配到事实 P ---');
const denied = inst({
  title: '她说她没给', verbType: '给', polarity: '-', participants: [['主角', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
});
inst({ title: '主角交出了卷宗', verbType: '给', participants: [['主角', '发起者']] });
r = alignPropositions(db, { chatId: CHAT });
check('极性相反 => refuted (不是兑现)',
  statusOf(denied.id).status === 'refuted', JSON.stringify(statusOf(denied.id)));

console.log('\n--- ③ 宁缺勿错: 题元重叠不足则保持未决 ---');
const vague = inst({
  title: '她看了', verbType: '看', participants: [['艾拉', '发起者'], ['神秘人', '目击者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
});
inst({ title: '艾拉环顾四周', verbType: '看', participants: [['艾拉', '发起者']] });
r = alignPropositions(db, { chatId: CHAT });
const vagueScore = matchScore(db, db.prepare('SELECT * FROM events WHERE id = ?').get(vague.id),
  db.prepare("SELECT * FROM v_facts WHERE title = '艾拉环顾四周'").get());
check('重叠 1/2 => 打分低于阈值 (0.75 < 0.8)',
  vagueScore != null && vagueScore.score < VERB_LAYER.alignment.threshold,
  JSON.stringify(vagueScore));
check('因此保持 pending, 不强行判兑现', statusOf(vague.id).status === 'pending', statusOf(vague.id).status);
check('动词不同直接不匹配', matchScore(db,
  db.prepare('SELECT * FROM events WHERE id = ?').get(vague.id),
  db.prepare("SELECT * FROM v_facts WHERE title = '她去了镇上'").get()) === null);

console.log('\n--- ④ 到点未兑现 => 落空 ---');
const errand = inst({
  title: '说好转交', verbType: '转交', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', tense: 'future', timeId: day1.id, sourceName: '艾拉',
});
r = alignPropositions(db, { chatId: CHAT });
check('所在时间节点之后已有更晚节点 => failed',
  statusOf(errand.id).status === 'failed', statusOf(errand.id).status);
check('无时间锚的命题不判到点 (留下未决)', (() => {
  const noAnchor = inst({
    title: '无锚承诺', verbType: '承诺', participants: [['神秘人', '发起者']],
    sourceType: 'attributed', status: 'pending', tense: 'future', sourceName: '神秘人',
  });
  alignPropositions(db, { chatId: CHAT });
  return statusOf(noAnchor.id).status === 'pending';
})());

console.log('\n--- ⑤ 条件未成立 => 未激活 ---');
const threat = inst({
  title: '威胁', verbType: '威胁', participants: [['神秘人', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '神秘人',
});
const give = inst({
  title: '若交给你', verbType: '给', polarity: '-', participants: [['主角', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '主角',
  parent: { id: threat.id }, role: 'cond',
});
addEventLink(db, { fromId: give.id, toId: threat.id, relation: 'conditional' });
db.prepare("UPDATE events SET status = 'failed' WHERE id = ?").run(give.id);
r = alignPropositions(db, { chatId: CHAT });
check('条件落空 => 后果转 inactive',
  statusOf(threat.id).status === 'inactive', statusOf(threat.id).status);
check('摘要含 inactive 项', r.inactive.some((x) => x.id === threat.id), JSON.stringify(r.inactive));

console.log('\n--- ⑥ 择一: 一个兑现, 其余作废 ---');
const choicePoint = inst({
  title: '要么去镇上要么去酒馆', verbType: '选', participants: [['主角', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '主角',
});
const altA = inst({
  title: '去镇上', verbType: '去', participants: [['主角', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '主角',
  parent: { id: choicePoint.id }, role: 'alt',
});
const altB = inst({
  title: '去酒馆', verbType: '去', participants: [['主角', '发起者']], locationId: null,
  sourceType: 'attributed', status: 'pending', sourceName: '主角',
  parent: { id: choicePoint.id }, role: 'alt',
});
// 与 altA 匹配的事实
inst({ title: '主角抵达镇上', verbType: '去', participants: [['主角', '发起者']] });
r = alignPropositions(db, { chatId: CHAT });
check('其中一个候选兑现', statusOf(altA.id).status === 'realized' || statusOf(altB.id).status === 'realized',
  JSON.stringify({ a: statusOf(altA.id).status, b: statusOf(altB.id).status }));
check('其余候选作废 (voided)',
  [statusOf(altA.id).status, statusOf(altB.id).status].filter((s) => s === 'voided').length === 1,
  JSON.stringify({ a: statusOf(altA.id).status, b: statusOf(altB.id).status }));
check('作废项计入摘要', r.voided.length >= 1, JSON.stringify(r.voided));

console.log('\n--- ⑦ 从句级联: 谎话被拆穿 / 陈述被证实 ---');
// (a) 她说"她去过了"(从句), 而事实是她没去 => 宿主被推翻
const claim = inst({
  title: '她的说法', verbType: '说', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
});
const claimComp = inst({
  title: '她去过王都', verbType: '抵达', polarity: '-', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
  parent: { id: claim.id }, role: 'comp',
});
inst({ title: '艾拉抵达王都', verbType: '抵达', participants: [['艾拉', '发起者']] });
r = alignPropositions(db, { chatId: CHAT });
check('从句 ¬P 匹配事实 P => 从句 refuted', statusOf(claimComp.id).status === 'refuted', statusOf(claimComp.id).status);
check('宿主随之被推翻 (撒谎 / 说错) => hostRefuted',
  statusOf(claim.id).status === 'refuted' && r.hostRefuted.some((x) => x.id === claim.id),
  JSON.stringify({ host: statusOf(claim.id).status, r: r.hostRefuted }));

// (b) 她说"她会去"(从句), 事实是她去了 => 宿主被证实
const claim2 = inst({
  title: '她的预告', verbType: '说', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
});
const claim2Comp = inst({
  title: '她会去酒馆', verbType: '走', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', tense: 'future', sourceName: '艾拉',
  parent: { id: claim2.id }, role: 'comp',
});
inst({ title: '艾拉走进酒馆', verbType: '走', participants: [['艾拉', '发起者']] });
r = alignPropositions(db, { chatId: CHAT });
check('从句兑现 => 宿主证实 (hostRealized)',
  statusOf(claim2Comp.id).status === 'realized' && statusOf(claim2.id).status === 'realized',
  JSON.stringify({ comp: statusOf(claim2Comp.id).status, host: statusOf(claim2.id).status }));

console.log('\n--- ⑧ 有未决从句的命题自己不参与匹配 (防低特异性动词泛匹配) ---');
const chatty = inst({
  title: '她说了很多', verbType: '说', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
});
inst({
  title: '她打算离开', verbType: '离开', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉',
  parent: { id: chatty.id }, role: 'comp',
});
// 同一聊天里存在一条"艾拉说"的事实 (若只看动词+参与者, 会把宿主误判兑现)
inst({ title: '夜谈', verbType: '说', participants: [['艾拉', '发起者']] });
alignPropositions(db, { chatId: CHAT });
check('宿主保持 pending (它的内容是从句在管)',
  statusOf(chatty.id).status === 'pending', statusOf(chatty.id).status);

console.log('\n--- ⑨ 幂等: 再跑一轮无副作用 ---');
const before = db.prepare("SELECT id, status, aligned_instance_id FROM events ORDER BY id").all();
const r2 = alignPropositions(db, { chatId: CHAT });
const after = db.prepare("SELECT id, status, aligned_instance_id FROM events ORDER BY id").all();
check('重复对齐不改变任何状态', JSON.stringify(before) === JSON.stringify(after));
check('第二轮摘要为空', Object.values(r2).every((v) => v.length === 0), JSON.stringify(r2));

console.log('\n--- ⑩ 跨聊天不串味 ---');
const otherChatProp = inst({
  title: '别的聊天的承诺', verbType: '去', participants: [['艾拉', '发起者']],
  sourceType: 'attributed', status: 'pending', sourceName: '艾拉', chatId: 'chat-other',
});
alignPropositions(db, { chatId: CHAT });
check('限定 chat 时不影响其他聊天的命题',
  statusOf(otherChatProp.id).status === 'pending', statusOf(otherChatProp.id).status);

console.log('\n--- ⑪ 注入分组口径: 未决进【待兑现】, 已定局的声称进时间线 ---');
const timeline = chatTimeline(db, { chatId: CHAT });
const tIds = timeline.map((e) => e.id);
check('时间线状态限于 timelineStatuses',
  timeline.every((e) => VERB_LAYER.timelineStatuses.includes(e.status)),
  JSON.stringify(timeline.map((e) => `${e.title}:${e.status}`)));
check('未决项不进时间线 (她说了很多 / 要么… / 她的预告之后的未决)',
  !tIds.includes(chatty.id) && !tIds.includes(choicePoint.id)
  && !timeline.some((e) => e.status === 'pending'),
  JSON.stringify(timeline.map((e) => `${e.title}:${e.status}`)));
check('未发生的也不进时间线 (落空 / 未激活 / 作废)',
  !tIds.includes(errand.id) && !tIds.includes(threat.id),
  JSON.stringify(timeline.map((e) => e.title)));
check('已被拆穿的声称进时间线, 且标出是归属 (isProposition)',
  tIds.includes(claim.id)
  && timeline.find((e) => e.id === claim.id).isProposition === true
  && timeline.find((e) => e.id === claim.id).status === 'refuted',
  JSON.stringify(timeline.find((e) => e.id === claim.id) ?? null));
check('时间线带出动词槽 (V6 新字段)',
  timeline.every((e) => typeof e.verbType === 'string' && e.verbType.length > 0),
  JSON.stringify(timeline.map((e) => `${e.title}:${e.verbType}`)));

console.log('\n--- ⑫ 未决清单 (【待兑现】段的数据源) ---');
const pending = chatPending(db, { chatId: CHAT });
check('未决清单含全部 pending 实例',
  pending.length === db.prepare("SELECT COUNT(*) n FROM events WHERE chat_id = ? AND status='pending'").get(CHAT).n,
  JSON.stringify(pending.map((p) => p.content)));
check('内容优先取从句 (她说的事), 并带持有者',
  pending.some((p) => p.holderName === '艾拉' && p.content.includes('离开')),
  JSON.stringify(pending.map((p) => `${p.holderName}:${p.content}`)));
check('跨聊天不串味 (其他聊天的未决不进本聊天清单)',
  !pending.some((p) => p.id === otherChatProp.id));

const ents = keyEntities(db, { chatId: CHAT });
const degreeNames = new Set(ents.map((e) => e.name));
check('关键实体度数只按事实统计 (只在命题里出现的人不因命题而进目录)',
  !degreeNames.has('神秘人') || ents.find((e) => e.name === '神秘人').degree === 0,
  JSON.stringify(ents.map((e) => `${e.name}:${e.degree}`)));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
