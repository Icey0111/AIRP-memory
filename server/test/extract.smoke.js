// 述谓实例抽取冒烟测试: 内存库 + mock LLM, 不触碰真实数据库
// 运行: node test/extract.smoke.js
//
// V6 起抽取的产物从"事件"变为"述谓实例"(谁—动词—谁 + 来源/时态/极性)。
// 本套测试钉住的是**流程与落库**: 实体归并、地点层级、时间点、题元参与者、
// 引用桥、因果边、幂等。
// 而"归属命题 / 三轴 / 嵌套 / 归并触发权"这类动词层特有的不变量, 归 test/verbs.smoke.js。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { extractInstances, SYSTEM_PROMPT } from '../src/services/extractionService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MOCK_LLM_JSON = JSON.stringify({
  people: [
    { name: '主角', person_type: 'main' },
    { name: '艾拉', aliases: ['精灵游侠'], person_type: 'npc' },
  ],
  locations: [{ name: '夜莺酒馆', parent: '王都' }],
  time_point: { label: '第三夜, 暴雨', seq: 3 },
  instances: [
    {
      label: '酒馆初遇',
      verb_type: '遇',
      verb_surface: '搭话',
      tense: 'past',
      participants: [
        { name: '主角', role: '参与者' },
        { name: '精灵游侠', role: '参与者' },  // 用别名, 应归并到艾拉
      ],
      location: '夜莺酒馆',
      importance: 0.7,
      result_note: '互留姓名, 戒备稍减',
    },
    {
      label: '同行启程',
      verb_type: '去',
      participants: [
        { name: '主角', role: '发起者' },
        { name: '艾拉', role: '参与者' },
      ],
      importance: 0.6,
      caused_by: '酒馆初遇',
    },
  ],
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

const llm = createLlmClient({ provider: 'mock', mockResponse: MOCK_LLM_JSON });

const r1 = await extractInstances(db, llm, {
  chatId: 'chat001',
  text: '(测试文本, mock 通道不读)',
  sourceMessageIds: ['m1', 'm2'],
});

console.log('\n--- 第一次抽取 ---');
check('人物数=2', r1.people.length === 2);
check('地点含夜莺酒馆', r1.locations.some((l) => l.name === '夜莺酒馆'));
check('时间点已建', r1.timePoint?.label === '第三夜, 暴雨');
check('实例数=2', r1.instances.length === 2, JSON.stringify(r1.instances.map((i) => i.title)));
check('因果边=1', r1.links.length === 1 && r1.links[0].from === '酒馆初遇' && r1.links[0].to === '同行启程',
  JSON.stringify(r1.links));
check('一阶事件记忆=2', r1.memoryIds.length === 2);
check('无跳过项', r1.skipped === 0);

// 别名归并: "精灵游侠" 不应产生第三个人物
const peopleCount = db.prepare('SELECT COUNT(*) n FROM people').get().n;
check('别名归并: people 表仅 2 行', peopleCount === 2, `实际 ${peopleCount}`);
const ella = db.prepare("SELECT * FROM people WHERE name='艾拉'").get();
check('艾拉别名含精灵游侠', JSON.parse(ella.aliases).includes('精灵游侠'));

// 参与者解析: 酒馆初遇的两条参与者应指向 主角 与 艾拉(同一 id)
const ev1 = db.prepare("SELECT * FROM events WHERE title='酒馆初遇'").get();
const parts = db.prepare('SELECT person_id, role FROM event_participants WHERE event_id = ? ORDER BY person_id').all(ev1.id);
check('酒馆初遇参与者=2', parts.length === 2, `实际 ${parts.length}`);
check('题元角色落库 (参与者)', parts.every((p) => p.role === '参与者'));

// 地点层级: 夜莺酒馆.parent -> 王都
const tavern = db.prepare("SELECT * FROM locations WHERE name='夜莺酒馆'").get();
const capital = db.prepare("SELECT * FROM locations WHERE name='王都'").get();
check('夜莺酒馆父级=王都', tavern.parent_id === capital.id);

// 实例的时间/地点挂载 + 动词槽
check('实例挂载时间点', ev1.time_id === r1.timePoint.id);
check('实例挂载地点', ev1.location_id === tavern.id);
check('动词槽落库 (verb_type=遇, verb_surface=搭话)',
  ev1.verb_type === '遇' && ev1.verb_surface === '搭话');
check('叙述者断言默认三轴值 (narrator/asserted/past/+)',
  ev1.source_type === 'narrator' && ev1.status === 'asserted'
  && ev1.tense === 'past' && ev1.polarity === '+');
check('叙事结果写进 result_text', ev1.result_text.includes('互留姓名'));

// 引用桥: 记忆 → 人/地点/事件
const refs = db.prepare('SELECT entity_type, COUNT(*) n FROM memory_entity_refs GROUP BY entity_type').all();
const refMap = Object.fromEntries(refs.map((r) => [r.entity_type, r.n]));
check('引用桥 person/location/event 均存在', refMap.person >= 2 && refMap.location >= 1 && refMap.event >= 2, JSON.stringify(refMap));

// 因果边落库
const link = db.prepare(`
  SELECT e1.title f, e2.title t FROM event_links k
  JOIN events e1 ON e1.id = k.from_id JOIN events e2 ON e2.id = k.to_id
`).get();
check('因果边 酒馆初遇-caused->同行启程', link?.f === '酒馆初遇' && link?.t === '同行启程');

console.log('\n--- 第二次抽取 (幂等) ---');
const r2 = await extractInstances(db, llm, { chatId: 'chat001', text: '(重复)' });
check('实例幂等: 2 条均标记 existed', r2.instances.every((e) => e.existed));
check('实例总数仍为 2', db.prepare('SELECT COUNT(*) n FROM events').get().n === 2);
check('人物总数仍为 2', db.prepare('SELECT COUNT(*) n FROM people').get().n === 2);
check('无重复事件记忆', r2.memoryIds.length === 0);

// 反查: 艾拉参与的实例 (V2 设计文档中的典型查询)
const rows = db.prepare(`
  SELECT e.title, t.label, l.name loc FROM event_participants p
  JOIN events e ON e.id = p.event_id
  LEFT JOIN time_points t ON t.id = e.time_id
  LEFT JOIN locations l ON l.id = e.location_id
  JOIN people pe ON pe.id = p.person_id
  WHERE pe.name = '艾拉' ORDER BY e.id
`).all();
check('反查艾拉参与的实例=2', rows.length === 2, JSON.stringify(rows));
console.log('  艾拉的实例线:', JSON.stringify(rows));

console.log('\n--- prompt 的动词层条款 (压缩要在入库时就做) ---');
check('prompt 要求区分叙述者断言与归属内容',
  SYSTEM_PROMPT.includes('source_type="narrator"') && SYSTEM_PROMPT.includes('source_type="attributed"'));
check('prompt 禁止把意图/承诺抽成叙述者实例',
  SYSTEM_PROMPT.includes('意图、承诺、计划、预测、威胁') && SYSTEM_PROMPT.includes('绝对不要把它们抽成叙述者实例'));
check('prompt 把实体归并的触发权限定给叙述者',
  SYSTEM_PROMPT.includes('只有叙述者断言才能触发实体归并'));
check('prompt 要求从句指过去也仍是"某人的声称"',
  SYSTEM_PROMPT.includes('从句指向过去也不代表它是事实'));
check('prompt 保持信息正交性 (正文不复述时间/人物/地点)',
  SYSTEM_PROMPT.includes('不要复述时间、人物、地点'));
check('prompt 要求重复日常照原样抽 (折叠交给管线)',
  SYSTEM_PROMPT.includes('不要自己合并'));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
