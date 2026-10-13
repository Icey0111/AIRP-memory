// 动词层与命题层冒烟测试 (V6, docs/verb-layer.md)
// 运行: node test/verbs.smoke.js
//
// 本套钉住的是**动词层特有的不变量** —— 抽取流程本身的覆盖在 test/extract.smoke.js。
// 五条底线:
//   1) 视图分路: 归属命题进 v_propositions, 绝不泄漏进 v_facts;
//   2) 归并触发权: 只有叙述者断言能触发实体别名归并 (人物层的同一性断言不行) —— 数据安全底线;
//   3) 嵌套引述有深度上限 (不设限会变成传话游戏);
//   4) 三轴/极性/状态按规则落库 (归属->未决, 叙述者对未来的断言->未决);
//   5) 归属命题不写一阶记忆 (不污染 FTS 检索)。
// 另有一条漂移哨兵: VERB_LAYER.linkRelations 必须与 schema 的 CHECK 词表一致。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { extractInstances } from '../src/services/extractionService.js';
import { findOrCreatePerson } from '../src/services/entityService.js';
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

const MOCK = JSON.stringify({
  people: [
    { name: '艾拉', aliases: ['小艾'], person_type: 'main' },
    { name: '主角', person_type: 'main' },
    { name: '神秘人', person_type: 'npc' },
  ],
  locations: [{ name: '镇上' }],
  time_point: { label: '第四日' },
  instances: [
    // ① 归属命题 + 命题宾语(意图): "艾拉说明天去镇上"
    {
      label: '艾拉的打算', verb_type: '说', tense: 'past',
      source_type: 'attributed', attitude: '说', source_name: '艾拉',
      participants: [{ name: '艾拉', role: '发起者' }],
      comp: {
        verb_type: '去', tense: 'future',
        participants: [{ name: '艾拉', role: '发起者' }], location: '镇上',
      },
    },
    // ② 叙述者实例 (对照组: 参与者用别名, 应归并到艾拉)
    {
      label: '夜谈', verb_type: '说', tense: 'past',
      participants: [{ name: '小艾', role: '发起者' }, { name: '主角', role: '对象' }],
    },
    // ③ 被引述的过去 + 否定极性: "她说她没去"
    {
      label: '她的否认', verb_type: '说', tense: 'past',
      source_type: 'attributed', attitude: '说', source_name: '艾拉',
      participants: [{ name: '艾拉', role: '发起者' }],
      comp: { verb_type: '去', polarity: '-', tense: 'past', participants: [{ name: '艾拉', role: '发起者' }] },
    },
    // ④ 条件命题 (威胁): 若你不给, 我就… (条件前件是"给我")
    {
      label: '威胁', verb_type: '威胁', tense: 'future',
      source_type: 'attributed', attitude: '说', source_name: '神秘人',
      participants: [{ name: '神秘人', role: '发起者' }, { name: '主角', role: '对象' }],
      conditional: { verb_type: '给', tense: 'future', polarity: '-', participants: [{ name: '主角', role: '发起者' }] },
    },
    // ⑤ 叙述者对未来的断言: 担保可信但尚未发生 -> 未决
    {
      label: '约定的明天', verb_type: '去', tense: 'future',
      participants: [{ name: '主角', role: '发起者' }],
    },
    // ⑥ 三层嵌套: 最内层超出深度上限, 应被丢弃并计入 skipped
    {
      label: '传话一', verb_type: '说',
      source_type: 'attributed', attitude: '说', source_name: '艾拉',
      comp: {
        verb_type: '说', source_type: 'attributed', attitude: '说', source_name: '主角',
        comp: { verb_type: '去', participants: [{ name: '主角', role: '发起者' }] },
      },
    },
  ],
});

const llm = createLlmClient({ provider: 'mock', mockResponse: MOCK });
const r = await extractInstances(db, llm, { chatId: 'chat-v6', text: '(mock)' });

console.log('\n--- 实例与嵌套 ---');
check('实例总数 = 10 (5 顶层 + 4 从句 + 1 条件前件)', r.instances.length === 10,
  JSON.stringify(r.instances.map((i) => `${i.title}/${i.sourceType}`)));
check('三层嵌套被丢弃并计数 (skipped=1)', r.skipped === 1, String(r.skipped));

const comp = db.prepare("SELECT * FROM events WHERE parent_role = 'comp' ORDER BY id").all();
check('命题宾语落 parent_role=comp 且挂上父实例',
  comp.length === 3 && comp.every((c) => c.parent_instance_id != null), String(comp.length));
const cond = db.prepare("SELECT * FROM events WHERE parent_role = 'cond'").get();
check('条件前件落 parent_role=cond', cond?.verb_type === '给', JSON.stringify(cond));
check('深度上限生效: 所有子实例的父实例都是顶层 (不存在第 3 层)',
  db.prepare(`
    SELECT COUNT(*) n FROM events child
    JOIN events parent ON parent.id = child.parent_instance_id
    WHERE child.parent_instance_id IS NOT NULL AND parent.parent_instance_id IS NOT NULL
  `).get().n === 0);

console.log('\n--- 三轴 / 极性 / 状态 ---');
const byTitle = (t) => db.prepare('SELECT * FROM events WHERE title = ?').get(t);
const plan = byTitle('艾拉的打算');
check('归属命题: source_type=attributed + 持有者 + 情态',
  plan.source_type === 'attributed' && plan.attitude === '说'
  && plan.source_person_id === db.prepare("SELECT id FROM people WHERE name='艾拉'").get().id);
check('归属命题默认状态 = pending (未决)', plan.status === 'pending', plan.status);
check('从句保留未来时态 (意图)', byTitle('去')?.tense === 'future' || comp.some((c) => c.tense === 'future'));
check('从句继承宿主来源: 归属命题的从句也是归属 (不写成事实)',
  comp.filter((c) => c.parent_instance_id === byTitle('艾拉的打算').id)
    .every((c) => c.source_type === 'attributed' && c.status === 'pending'),
  JSON.stringify(comp.map((c) => `${c.verb_type}:${c.source_type}`)));
check('否定极性落库 (她说她没去)', comp.some((c) => c.polarity === '-' && c.tense === 'past'));
check('叙述者过去 = asserted', byTitle('夜谈').status === 'asserted');
check('叙述者的未来断言 = pending (担保可信但尚未发生)',
  byTitle('约定的明天').status === 'pending' && byTitle('约定的明天').tense === 'future');

console.log('\n--- 视图分路 (命题不得泄漏进事实层) ---');
const facts = db.prepare('SELECT COUNT(*) n FROM v_facts').get().n;
const props = db.prepare('SELECT COUNT(*) n FROM v_propositions').get().n;
check('事实视图 = 2 (仅两条叙述者实例)', facts === 2, String(facts));
check('命题视图 = 8 (归属实例及其从句/条件前件)', props === 8, String(props));
check('两视图之和 = 实例总数 10', facts + props === 10);
check('命题视图里没有任何 narrator 行',
  db.prepare("SELECT COUNT(*) n FROM v_propositions WHERE source_type = 'narrator'").get().n === 0);

console.log('\n--- 归并触发权 (数据安全底线) ---');
// 直接检验机制: 归属路径不得把新名字挂成既有实体的别名
const ellaId = db.prepare("SELECT id FROM people WHERE name='艾拉'").get().id;
findOrCreatePerson(db, { name: '艾拉', aliases: ['神秘人'], mergeAliases: false });
const afterFalse = JSON.parse(db.prepare('SELECT aliases FROM people WHERE id = ?').get(ellaId).aliases);
check('mergeAliases=false: 归属路径不写入新别名 (不可逆归并因此不会发生)',
  !afterFalse.includes('神秘人'), JSON.stringify(afterFalse));
findOrCreatePerson(db, { name: '艾拉', aliases: ['精灵游侠'], mergeAliases: true });
const afterTrue = JSON.parse(db.prepare('SELECT aliases FROM people WHERE id = ?').get(ellaId).aliases);
check('mergeAliases=true (对照组): 叙述者路径正常归并',
  afterTrue.includes('精灵游侠'), JSON.stringify(afterTrue));
check('抽取全程未产生多余人物 (3 人)',
  db.prepare('SELECT COUNT(*) n FROM people').get().n === 3,
  String(db.prepare('SELECT COUNT(*) n FROM people').get().n));

console.log('\n--- 一阶记忆不被未证实内容污染 ---');
const mems = db.prepare('SELECT content FROM memories ORDER BY id').all();
check('只有叙述者实例写记忆 (2 条)', mems.length === 2, String(mems.length));
check('记忆内容不含归属命题 (打算/否认/威胁/传话)',
  !mems.some((m) => /打算|否认|威胁|传话|给/.test(m.content)), JSON.stringify(mems.map((m) => m.content)));

console.log('\n--- 条件边 ---');
const link = db.prepare("SELECT * FROM event_links WHERE relation = 'conditional'").get();
check('条件边已建立 (条件前件 -> 后果)', link != null && link.to_id === byTitle('威胁').id,
  JSON.stringify(link));
check('上报的 links 含 conditional', r.links.some((l) => l.relation === 'conditional'), JSON.stringify(r.links));

console.log('\n--- 漂移哨兵: 契约常量 vs schema CHECK ---');
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_links'").get().sql;
const inSql = (sql.match(/relation IN \(([^)]*)\)/) ?? [, ''])[1]
  .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
check('VERB_LAYER.linkRelations 与 schema 的 CHECK 词表完全一致',
  JSON.stringify([...inSql].sort()) === JSON.stringify([...VERB_LAYER.linkRelations].sort()),
  `\n    schema: ${inSql.join(',')}\n    常量  : ${VERB_LAYER.linkRelations.join(',')}`);
check('三轴枚举齐备且状态含「未激活 / 已作废」',
  VERB_LAYER.tenses.length === 3
  && VERB_LAYER.statuses.some((s) => s.value === 'inactive')
  && VERB_LAYER.statuses.some((s) => s.value === 'voided'));
check('题元角色与嵌套角色已定义',
  VERB_LAYER.thematicRoles.length >= 6 && VERB_LAYER.parentRoles.map((p) => p.value).join(',') === 'comp,cond,alt');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
