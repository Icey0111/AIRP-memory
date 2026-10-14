// 词表层冒烟测试 (V10, docs/vocabulary-layer.md)
//
// 钉住的是"语义落成可复用节点"这件事的**每一条机制**, 尤其是它换来的那个能力:
//   1) 归一 (含跨语言/同义/标点空白) 是确定性的, 而且发生在**落库前**
//   2) 词表外的词不丢: 进待审队列 + 按上位类挂好 (短语型谓词绝不自动拆词)
//   3) 文本缓存与元素指针**零漂移**; 种子幂等; 回填幂等
//   4) ★ 命题对齐按**元素 id** 判"同不同一个词" —— 于是"前往"与"去"能对上,
//      真假判定第一次真的跑起来 (此前 10 条归属命题 0 条判定)
//   5) 是否疑问 = 一对 alt 候选竞争 (恰有一个定局, 另一个作废)
//   6) 归并 (merge) 改指针 + 保留写法 + 不留残影
// 运行: node test/vocabulary.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import {
  findOrCreatePerson, findOrCreateTimePoint, createEvent, addEventParticipant,
} from '../src/services/entityService.js';
import { applyStance } from '../src/services/stanceService.js';
import { addChunk } from '../src/services/chunkService.js';
import { alignPropositions, matchScore } from '../src/services/alignmentService.js';
import {
  normalizeWord, seedVocabulary, backfillVocabulary, auditVocabulary, mergeVocabulary,
  parseTimeLabel, timeParentOf,
} from '../src/services/vocabularyService.js';
import { VOCABULARY, VOCABULARY_WORDS } from '../src/domain/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});
const CHAT = 'vocab-test';
const nowTs = Math.floor(Date.now() / 1000);
const statusOf = (id) => db.prepare('SELECT status FROM events WHERE id = ?').get(id).status;
const nodeOf = (id) => db.prepare('SELECT * FROM value_nodes WHERE id = ?').get(id);
const parentNameOf = (id) => {
  const n = nodeOf(id);
  return n?.parent_id ? nodeOf(n.parent_id).name : null;
};

// ---------- 1) 归一: 纯函数, 确定性 ----------
console.log('\n--- 1) 归一 (确定性, 跨语言/同义/脏字符) ---');
{
  check('跨语言题元写法 (agent -> 发起者)', normalizeWord('role', 'agent')?.word === '发起者');
  check('中文维度写法 (外貌 -> appearance)', normalizeWord('aspect', '外貌')?.word === 'appearance');
  check('情态同义 (声称 -> 说)', normalizeWord('attitude', '声称')?.word === '说');
  check('从句角色 (从句 -> comp)', normalizeWord('clause', '从句')?.word === 'comp');
  check('立场同义 (敌对 -> 敌视)', normalizeWord('stance_type', '敌对')?.word === '敌视');
  check('表面处理: 折叠空白/去首尾标点/英文不区分大小写',
    normalizeWord('role', '  AGENT。 ')?.word === '发起者'
    && normalizeWord('predicate', ' 去 ')?.word === '去');
  check('词表外的词如实报未命中 (不硬塞进某个规范词)',
    normalizeWord('predicate', '腾空翻越')?.hit === false);
  check('短语型谓词不自动拆词 (拆错比不拆更有害)',
    normalizeWord('predicate', '拦截盘查')?.word === '拦截盘查'
    && normalizeWord('predicate', '拦截盘查')?.hit === false);
  check('规范词只定义一次 (全部落在 constants 的枚举里)',
    VOCABULARY_WORDS.role.every((w) => normalizeWord('role', w)?.hit)
    && VOCABULARY_WORDS.predicate.every((w) => normalizeWord('predicate', w)?.hit));
}

// ---------- 2) 落库前归一 (写入路径唯一入口) ----------
console.log('\n--- 2) 落库前归一 + 指针 (写入路径) ---');
const you = findOrCreatePerson(db, { name: '你', personType: 'main' });
const ella = findOrCreatePerson(db, { name: '艾拉' });
const other = findOrCreatePerson(db, { name: '路人乙' });
const tp = findOrCreateTimePoint(db, { chatId: CHAT, label: '第三夜, 暴雨', seq: 1 });
{
  const e = createEvent(db, {
    chatId: CHAT, title: '她声称去过镇上', verbType: '给', verbSurface: '塞给',
    sourceType: 'attributed', sourcePersonId: ella.id, attitude: '声称',
    parentRole: '从句', timeId: tp.id,
  });
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(e);
  check('谓词归一 (给 -> 给予) 且挂上元素指针',
    row.verb_type === '给予' && row.predicate_id != null && nodeOf(row.predicate_id).name === '给予');
  check('情态归一 (声称 -> 说)', row.attitude === '说' && row.attitude_id != null);
  check('从句角色归一 (从句 -> comp)', row.parent_role === 'comp' && row.clause_id != null);
  check('对齐状态也接指针 (attributed => pending)',
    row.status === 'pending' && row.status_id != null && nodeOf(row.status_id).name === 'pending');

  addEventParticipant(db, { eventId: e, personId: you.id, role: 'agent' });
  addEventParticipant(db, { eventId: e, personId: you.id, role: '发起者' });
  const parts = db.prepare('SELECT role, role_id FROM event_participants WHERE event_id = ?').all(e);
  check('题元角色归一 + 主键去重 (agent 与 发起者 合成一条, 旧口径是两行)',
    parts.length === 1 && parts[0].role === '发起者' && parts[0].role_id != null, JSON.stringify(parts));

  const st = applyStance(db, {
    holderType: 'person', holderId: ella.id, targetType: 'person', targetId: you.id,
    stanceType: '敌对', chatId: CHAT,
  });
  const srow = db.prepare('SELECT stance_type, stance_type_id FROM stances WHERE id = ?').get(st.id);
  check('立场类型归一 (敌对 -> 敌视) 且挂指针',
    srow.stance_type === '敌视' && srow.stance_type_id != null, JSON.stringify(srow));

  const cid = addChunk(db, {
    entityType: 'person', entityId: ella.id, aspect: '外貌', content: '银发', chatId: CHAT,
  });
  const crow = db.prepare('SELECT aspect, aspect_id FROM attribute_chunks WHERE id = ?').get(cid);
  check('观察维度归一 (外貌 -> appearance) 且挂指针',
    crow.aspect === 'appearance' && crow.aspect_id != null, JSON.stringify(crow));
}

// ---------- 3) 词表外的词: 不丢, 进待审, 挂上位类 ----------
console.log('\n--- 3) 词表外的词: 进待审队列, 不静默丢弃 ---');
const escort = createEvent(db, { chatId: CHAT, title: '押送俘虏', verbType: '押送' });
{
  const row = db.prepare('SELECT verb_type, predicate_id FROM events WHERE id = ?').get(escort);
  const n = nodeOf(row.predicate_id);
  check('原词照原样入库 (绝不丢弃抽取结果)', row.verb_type === '押送');
  check('新词标 needs_review 且来源是 extracted',
    n.name === '押送' && n.status === 'needs_review' && n.source === 'extracted', JSON.stringify(n));
  check('新词按上位类挂好 (押送 -> 位移)', parentNameOf(n.id) === '位移', String(parentNameOf(n.id)));
  const audit = auditVocabulary(db);
  check('待审队列里能看到它 (复用度一并给出)',
    audit.needsReview.some((x) => x.kind === 'predicate' && x.name === '押送' && x.count === 1));
}

// ---------- 4) 零漂移 / 幂等 ----------
console.log('\n--- 4) 文本缓存 vs 元素指针: 零漂移; 种子与回填幂等 ---');
{
  const a = auditVocabulary(db);
  check('文本缓存与指针零漂移 (写了就有指针)', a.drift.length === 0, JSON.stringify(a.drift.slice(0, 3)));
  check('七个域都有元素且复用度可统计',
    ['predicate', 'role', 'attitude', 'clause', 'status', 'aspect', 'stance_type']
      .every((k) => a.kinds[k] && a.kinds[k].nodes > 0 && a.kinds[k].reuse > 0),
    JSON.stringify(Object.fromEntries(Object.entries(a.kinds).map(([k, v]) => [k, v.reuse]))));
  const again = seedVocabulary(db);
  check('种子词表幂等 (第二次不再新建/不改动)', again.created === 0 && again.updated === 0, JSON.stringify(again));
}

// ---------- 5) ★ 真假判定靠词表: 同义写法能对上 ----------
console.log('\n--- 5) ★ 按元素判"同一个词": 真假判定第一次真的跑起来 ---');
{
  // 事实: 她去了镇上 (叙述者断言)
  const fact = createEvent(db, {
    chatId: CHAT, title: '艾拉抵达镇上', verbType: '去', sourceType: 'narrator', status: 'asserted', timeId: tp.id,
  });
  addEventParticipant(db, { eventId: fact, personId: ella.id, role: '发起者' });

  // 命题: 她说她会**前往**镇上 (同义写法, 字符串不同; 从句独立参与对齐)
  const host = createEvent(db, {
    chatId: CHAT, title: '她说她会去镇上', verbType: '说',
    sourceType: 'attributed', sourcePersonId: ella.id, attitude: '说', status: 'pending', timeId: tp.id,
  });
  const comp = createEvent(db, {
    chatId: CHAT, title: '前往镇上', verbType: '前往', sourceType: 'attributed',
    tense: 'past', status: 'pending', timeId: tp.id, parentInstanceId: host, parentRole: 'comp',
  });
  addEventParticipant(db, { eventId: comp, personId: ella.id, role: '发起者' });

  const factRow = db.prepare('SELECT * FROM events WHERE id = ?').get(fact);
  const propRow = db.prepare('SELECT * FROM events WHERE id = ?').get(comp);
  check('同义写法归一到同一个元素 ("前往" ≡ "去")',
    propRow.predicate_id === factRow.predicate_id
    && propRow.verb_type === factRow.verb_type && propRow.verb_type === '去',
    `${propRow.verb_type}#${propRow.predicate_id} vs ${factRow.verb_type}#${factRow.predicate_id}`);
  check('对齐的硬条件按元素判等 (字符串不同也照样匹配)',
    matchScore(db, propRow, factRow) != null);
  check('不同动词仍然不匹配 (硬条件没被放松)', (() => {
    const far = createEvent(db, { chatId: CHAT, title: '无关的事', verbType: '战斗', sourceType: 'narrator', status: 'asserted', timeId: tp.id });
    addEventParticipant(db, { eventId: far, personId: ella.id, role: '发起者' });
    return matchScore(db, propRow, db.prepare('SELECT * FROM events WHERE id = ?').get(far)) === null;
  })());

  const r = alignPropositions(db, { chatId: CHAT });
  check('从句被判定兑现 (真假判定不再空转)', statusOf(comp) === 'realized', `${statusOf(comp)} ${JSON.stringify(r.realized.map((x) => x.id))}`);
  check('从句兑现级联到宿主 (她说的是真的 => 证实)', statusOf(host) === 'realized', statusOf(host));
  check('事实一侧不受影响', statusOf(fact) === 'asserted');
}

// ---------- 6) 是否疑问 = 一对 alt 候选竞争 ----------
console.log('\n--- 6) 是否疑问: 一对 alt 候选 (正反问), 竞争定局 ---');
{
  const ask = createEvent(db, {
    chatId: CHAT, title: '她问他是否来了', verbType: '问',
    sourceType: 'attributed', sourcePersonId: ella.id, attitude: '问', status: 'pending', timeId: tp.id,
  });
  const yes = createEvent(db, {
    chatId: CHAT, title: '他来了', verbType: '来', sourceType: 'attributed',
    status: 'pending', timeId: tp.id, parentInstanceId: ask, parentRole: 'alt',
  });
  addEventParticipant(db, { eventId: yes, personId: other.id, role: '发起者' });
  // 反候选: 题元对不上 (说话人是别人), 所以它匹配不到事实 —— 用来把竞争结果钉成确定的
  const no = createEvent(db, {
    chatId: CHAT, title: '他没来', verbType: '来', polarity: '-', sourceType: 'attributed',
    status: 'pending', timeId: tp.id, parentInstanceId: ask, parentRole: 'alt',
  });
  addEventParticipant(db, { eventId: no, personId: you.id, role: '发起者' });

  const came = createEvent(db, {
    chatId: CHAT, title: '他确实来了', verbType: '来', sourceType: 'narrator', status: 'asserted', timeId: tp.id,
  });
  addEventParticipant(db, { eventId: came, personId: other.id, role: '发起者' });

  const askRow = db.prepare('SELECT attitude, attitude_id FROM events WHERE id = ?').get(ask);
  check('「是否」落成宿主 attitude=问 (枚举里补的那一个)',
    askRow.attitude === '问' && askRow.attitude_id != null && nodeOf(askRow.attitude_id).kind === 'attitude');
  check('两个候选都是 alt 从句', db.prepare("SELECT count(*) c FROM events WHERE parent_instance_id = ? AND parent_role = 'alt'").get(ask).c === 2);

  alignPropositions(db, { chatId: CHAT });
  const st = [statusOf(yes), statusOf(no)];
  check('择一是竞争: 恰有一个定局, 另一个作废 (不是各自独立判定)',
    st.filter((s) => s === 'realized' || s === 'refuted').length === 1 && st.filter((s) => s === 'voided').length === 1,
    st.join('/'));
  check('题元对不上的候选不作兑现 (宁缺勿错)', statusOf(no) === 'voided', statusOf(no));
}

// ---------- 7) 归并: 改指针 + 保留写法 + 不留残影 ----------
console.log('\n--- 7) 人工归并 (merge): 改指针 / 保留写法 / 不留残影 ---');
{
  const from = db.prepare("SELECT * FROM value_nodes WHERE kind = 'predicate' AND name = '押送'").get();
  const to = db.prepare("SELECT * FROM value_nodes WHERE kind = 'predicate' AND name = '去'").get();
  const moved = mergeVocabulary(db, 'predicate', from.id, to.id);
  check('实例改指目标元素', db.prepare('SELECT predicate_id FROM events WHERE id = ?').get(escort).predicate_id === to.id);
  check('文本缓存同步改写 (归并不制造漂移)',
    db.prepare('SELECT verb_type FROM events WHERE id = ?').get(escort).verb_type === '去');
  check('原话进目标别名 (写法不丢, 可反查)', JSON.parse(nodeOf(to.id).aliases).includes('押送'),
    nodeOf(to.id).aliases);
  check('源元素被删掉 (词表不留残影, 审计在别名里)',
    nodeOf(from.id) === undefined && JSON.stringify(moved.moved).length > 0);
  check('归并后零漂移 / 待审队列少一条',
    auditVocabulary(db).drift.length === 0
    && !auditVocabulary(db).needsReview.some((x) => x.name === '押送'),
    JSON.stringify(auditVocabulary(db).drift.slice(0, 3)));
  check('归并是不可逆的, 所以它有 --apply 门槛 (CLI 干跑默认不开火)',
    VOCABULARY.policy.merge.includes('不可逆') && VOCABULARY.policy.noPhraseMerge.includes('不自动拆词'));
}

// ---------- 8) 回填幂等 (旧库口径) ----------
console.log('\n--- 8) 旧数据回填: 机械归一, 可重复执行 ---');
{
  const legacy = Number(db.prepare(`INSERT INTO events (title, chat_id, verb_type, created_at, updated_at)
    VALUES ('旧行(未归一)', ?, '前往', ?, ?)`).run(CHAT, nowTs, nowTs).lastInsertRowid);
  const lp = Number(db.prepare(`INSERT INTO event_participants (event_id, person_id, role) VALUES (?, ?, 'agent')`)
    .run(legacy, you.id).lastInsertRowid ?? 0);
  const bf1 = backfillVocabulary(db);
  const lrow = db.prepare('SELECT verb_type, predicate_id FROM events WHERE id = ?').get(legacy);
  check('旧行的自由文本被机械归一 (前往 -> 去) 并接上指针',
    lrow.verb_type === '去' && lrow.predicate_id != null, JSON.stringify(lrow));
  check('旧参与边的角色也被归一 (agent -> 发起者)',
    db.prepare('SELECT role, role_id FROM event_participants WHERE event_id = ?').get(legacy).role === '发起者');
  check('回填确实做了事', Object.values(bf1.filled).reduce((a, b) => a + b, 0) > 0, JSON.stringify(bf1.filled));

  const bf2 = backfillVocabulary(db);
  check('回填幂等 (第二次零改动)',
    Object.values(bf2.filled).every((n) => n === 0) && bf2.created.length === 0 && bf2.merged.length === 0,
    JSON.stringify(bf2));

  // 旧库遗留的"别名元素" (旧口径 findOrCreateValue 随手建的) 应被并进规范元素
  db.prepare('INSERT INTO value_nodes (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('容貌', 'aspect', nowTs, nowTs);
  const bf3 = backfillVocabulary(db);
  check('旧别名元素被并入规范元素 (容貌 -> appearance)',
    bf3.merged.includes('aspect:容貌->appearance')
    && db.prepare("SELECT id FROM value_nodes WHERE kind = 'aspect' AND name = '容貌'").get() === undefined,
    JSON.stringify(bf3.merged));
  check('并入后零漂移', auditVocabulary(db).drift.length === 0,
    JSON.stringify(auditVocabulary(db).drift.slice(0, 3)));
  void lp;
}

// ---------- 9) 时间点抽象化: 时段元素 + 章节层级 + 安全拆分 ----------
console.log('\n--- 9) 时间点: 时段抽象层 / 安全拆分 / 章节层级 ---');
{
  check('时段归一 (夜里/暮色中 -> 夜/黄昏)',
    normalizeWord('time', '夜里')?.word === '夜' && normalizeWord('time', '暮色中')?.word === '黄昏');
  check('时段上位类 (黄昏 -> 夜, 清晨 -> 昼)',
    timeParentOf('黄昏') === '夜' && timeParentOf('清晨') === '昼');
  check('整句标签拆成 时段 + 修饰语',
    JSON.stringify(parseTimeLabel('夜晚，深渊暗潮侵袭之时')) === JSON.stringify({
      period: '夜', qualifier: '深渊暗潮侵袭之时', head: '夜晚', full: '夜晚，深渊暗潮侵袭之时', suffix: false,
    }), JSON.stringify(parseTimeLabel('夜晚，深渊暗潮侵袭之时')));
  check('没有时段词的标签不硬塞 (第三章 -> period=null)',
    parseTimeLabel('第三章')?.period === null && parseTimeLabel('第三章')?.head === '第三章');
  check('词尾命中也要认 (第三夜 / 血月之夜 -> 夜)',
    parseTimeLabel('第三夜')?.period === '夜' && parseTimeLabel('血月之夜')?.period === '夜');

  // 建一个整句标签的时间点: label 拆短, 整句进 note
  const tp1 = findOrCreateTimePoint(db, { chatId: CHAT, label: '暮色中，临近戌时三刻落闸', seq: 5 });
  check('拆分落库: label=时段头, note=修饰语 (原句不丢)',
    tp1.label === '暮色中' && tp1.note === '临近戌时三刻落闸', JSON.stringify({ l: tp1.label, n: tp1.note }));
  check('时段指针挂上 (暮色中 -> 黄昏)',
    tp1.period_id != null && nodeOf(tp1.period_id).kind === 'time' && nodeOf(tp1.period_id).name === '黄昏',
    JSON.stringify(nodeOf(tp1.period_id ?? 0)));
  check('时段挂上位类 (黄昏 -> 夜)', parentNameOf(tp1.period_id) === '夜');

  // 章节层级: 抽取输出里的 chapter 以前被静默丢弃, 现在接上
  const tp2 = findOrCreateTimePoint(db, { chatId: CHAT, label: '第三夜', seq: 6, chapter: '第三章' });
  check('章节落成上级时间点 (chapter -> parent_id)',
    tp2.parent_id != null && nodeOf(tp2.period_id)?.name === '夜');
  const chap = db.prepare('SELECT * FROM time_points WHERE id = ?').get(tp2.parent_id);
  check('章节的名字与标记如实保存', chap.label === '第三章' && chap.note === '章节');
  check('章节不占时间轴刻度 (seq 跟随子节点)', chap.seq === tp2.seq, `${chap.seq} vs ${tp2.seq}`);

  // 安全拆分: 同聊天里已有同名时间点且 note 不同 => 不拆 (宁可标签长, 不可并掉一个时刻)
  const tp3 = findOrCreateTimePoint(db, { chatId: CHAT, label: '暮色中，另一场雨' });
  check('会撞车时保持原样 (不把两个时刻并成一个)',
    tp3.label === '暮色中，另一场雨' && tp3.id !== tp1.id, JSON.stringify({ l: tp3.label, id: tp3.id }));

  check('时段域零漂移 (指针-only 域不参与漂移检查)',
    auditVocabulary(db).kinds.time && auditVocabulary(db).drift.every((d) => d.kind !== 'time'),
    JSON.stringify(auditVocabulary(db).drift.filter((d) => d.kind === 'time')));
  check('时段复用度可统计 (多个时间点共享同一个时段元素)',
    auditVocabulary(db).kinds.time.reuse >= 1, JSON.stringify(auditVocabulary(db).kinds.time));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
