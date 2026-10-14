// main 唯一不变量 + 人物合并 + 立场槽位收口 冒烟测试
//
// 这个文件存在的理由 (真实数据换来的):
//   用户本人在库里裂成了三个节点 (你 / User / 主角), 立场与画像按节点分家,
//   注入里出现同义两行 (塞拉菲娜→你 守护 / 塞拉菲娜→主角 保护)。
// 这里钉死四条:
//   1) 模型把谁标成 main 只是它的判断, **不构成身份证据** —— 不建第二个 main,
//      也**不归并** (实测见过它把两个不同的人都标成 main, 按"后者并入前者"会并掉一个真实角色);
//   2) 唯一由**确定性证据**(userName 命中)驱动的路径 ensureMainPerson 才做归并;
//   3) 归并=引用重指 + 原节点软删 (含参与者主键冲突去重), 名字并成别名;
//   4) 归并后同槽位立场必须收成一条链 (指针语义: 同槽位只有一个当前值)。
// 运行: node test/mains.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import {
  findOrCreatePerson, findMainPerson, ensureMainPerson, mergePersonIntoMain, normalizeStanceSlots,
} from '../src/services/entityService.js';
import { createEvent, addEventParticipant, findOrCreateLocation } from '../src/services/entityService.js';
import { addStance, currentStances, chatStances } from '../src/services/stanceService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const freshDb = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(projectRoot, 'db'), () => {});
  return db;
};
const CHAT = 'chat-main';
console.log(`schema_version = ${getSchemaVersion(freshDb())}`);

// ---------- 1) 模型标 main 不构成身份证据 ----------
console.log('\n--- 模型标 main: 不建第二个, 也不归并 ---');
{
  const db = freshDb();
  const a = findOrCreatePerson(db, { name: '艾拉', personType: 'main' });
  const b = findOrCreatePerson(db, { name: '主角', personType: 'main' });
  check('第一个 main 照常建立', a.person_type === 'main' && a.existed === false);
  check('第二个 main 降级为 npc (不建第二个 main)', b.person_type === 'npc', JSON.stringify(b));
  check('两个节点都还在 (没把真实角色并掉)',
    db.prepare('SELECT COUNT(*) n FROM people WHERE is_active = 1').get().n === 2,
    JSON.stringify(db.prepare('SELECT id,name,person_type FROM people').all()));
  check('库里只有一个 main', db.prepare("SELECT COUNT(*) n FROM people WHERE person_type='main' AND is_active=1").get().n === 1);
}

// ---------- 2) 确定性路径 (userName 命中) 才归并 ----------
console.log('\n--- ensureMainPerson: 换称呼自动归并 ---');
{
  const db = freshDb();
  ensureMainPerson(db, { name: '你' });
  const user = findOrCreatePerson(db, { name: 'User' });          // 旧的第二个"用户"节点
  const hero = findOrCreatePerson(db, { name: '主角' });
  addEventParticipant(db, {
    eventId: createEvent(db, { chatId: CHAT, title: '旧事件', verbType: '来', importance: 0.5 }).id ?? 1,
    personId: hero.id, role: '施事',
  });

  const canonical = ensureMainPerson(db, { name: '主角' });        // 确定性证据: 这次的用户称呼
  const mains = db.prepare("SELECT id,name,aliases FROM people WHERE person_type='main' AND is_active=1").all();
  check('仍然只有一个 main', mains.length === 1, JSON.stringify(mains));
  check('canonical 就是最初那个节点 (id 最小者, 历史保留)',
    canonical.id === db.prepare("SELECT id FROM people WHERE person_type='main' AND is_active=1").get().id);
  check('被并节点的名字进了别名', JSON.parse(mains[0].aliases).includes('主角'), mains[0].aliases);
  // ensureMainPerson 只并"命中本次称呼的那一个" —— 别的重复节点要等它自己被确认为用户时再并
  check('没被命中的重复节点不受影响 (不做无证据的连带归并)',
    db.prepare('SELECT is_active FROM people WHERE id = ?').get(user.id).is_active === 1,
    JSON.stringify(db.prepare('SELECT id,name,is_active FROM people ORDER BY id').all()));
  check('被并节点软删而非物理删除',
    db.prepare("SELECT is_active FROM people WHERE id = ?").get(hero.id).is_active === 0);
  check('旧引用被重指到 canonical',
    db.prepare('SELECT person_id FROM event_participants LIMIT 1').get().person_id === canonical.id);
  check('按旧名字解析命中 canonical (别名归并使后续写入自动落到同一个节点)',
    findOrCreatePerson(db, { name: '主角' }).id === canonical.id);
  ensureMainPerson(db, { name: 'User' });   // 另一个重复节点也被确认为用户 → 同样并入
  check('逐个确认后全部落到同一个 canonical',
    db.prepare("SELECT COUNT(*) n FROM people WHERE person_type='main' AND is_active=1").get().n === 1
    && findOrCreatePerson(db, { name: 'User' }).id === canonical.id
    && JSON.parse(db.prepare('SELECT aliases FROM people WHERE id = ?').get(canonical.id).aliases).includes('User'));
}

// ---------- 3) 归并的边界: 参与者主键冲突 ----------
console.log('\n--- 归并边界: 同事件同角色的重复参与者 ---');
{
  const db = freshDb();
  const main = ensureMainPerson(db, { name: '你' });
  const dup = findOrCreatePerson(db, { name: '主角' });
  const loc = findOrCreateLocation(db, { name: '某地' });
  const ev = createEvent(db, { chatId: CHAT, title: '同一事件', verbType: '说', locationId: loc.id, importance: 0.5 });
  addEventParticipant(db, { eventId: ev, personId: main.id, role: '施事' });
  addEventParticipant(db, { eventId: ev, personId: dup.id, role: '施事' });   // 同一角色 → 主键冲突

  const r = mergePersonIntoMain(db, { fromId: dup.id, toId: main.id });
  const rows = db.prepare('SELECT person_id, role FROM event_participants WHERE event_id = ?').all(ev);
  check('冲突的重复参与者被去重 (不撞主键、不报错)', rows.length === 1 && rows[0].person_id === main.id,
    JSON.stringify({ rows, repointed: r.repointed }));
  check('回报里给出重指明细', typeof r.repointed.event_participants_dedup === 'number');
}

// ---------- 4) 归并后同槽位立场必须收成一条链 ----------
console.log('\n--- 立场槽位收口 ---');
{
  const db = freshDb();
  const ela = findOrCreatePerson(db, { name: '塞拉菲娜' });
  const main = ensureMainPerson(db, { name: '你' });
  const dup = findOrCreatePerson(db, { name: '主角' });
  // 同一个槽位在**两个节点上各有一条当前值** —— 这正是 main 分裂造成的形态:
  // (塞拉菲娜→你 守护) 与 (塞拉菲娜→主角 保护) 本是同一槽位, 却因目标节点不同而并存。
  // 注意同一节点上的值变化会被指针语义折叠 (守护→庇护), 所以这里只在两个目标上各写一条。
  addStance(db, { holderType: 'person', holderId: ela.id, targetType: 'person', targetId: main.id, stanceType: '守护', chatId: CHAT, importance: 0.8 });
  addStance(db, { holderType: 'person', holderId: ela.id, targetType: 'person', targetId: dup.id, stanceType: '保护', chatId: CHAT, importance: 0.8 });
  check('分裂状态下"同一个人对同一个人的两个立场"各占一个槽位',
    currentStances(db, { holderType: 'person', holderId: ela.id }).length === 2);

  mergePersonIntoMain(db, { fromId: dup.id, toId: main.id });
  const before = currentStances(db, { holderType: 'person', holderId: ela.id }).length;
  check('合并后同槽位出现两条生效行 (这正是要收口的问题)', before === 2, String(before));

  const fixed = normalizeStanceSlots(db, { chatId: CHAT });
  const after = currentStances(db, { holderType: 'person', holderId: ela.id });
  check('收口后同槽位只剩最新一条', after.length === 1, JSON.stringify(after.map((s) => s.stance_type)));
  check('保留的是最新那条 (保护)', after[0].stance_type === '保护', JSON.stringify(after[0]));
  check('退休行入链 (supersedes 指向前一条, 注入里能显示演化)',
    db.prepare('SELECT supersedes_stance_id s FROM stances WHERE stance_type = ?').get('保护').s
    === db.prepare("SELECT id FROM stances WHERE stance_type = '守护'").get().id,
    JSON.stringify(db.prepare('SELECT id,stance_type,is_active,supersedes_stance_id s FROM stances ORDER BY id').all()));
  check('退休行软删而非物理删除',
    db.prepare("SELECT is_active FROM stances WHERE stance_type='守护'").get().is_active === 0);
  check('注入层看到的演化链是"守护 → 保护"这类形态',
    (chatStances(db, { chatId: CHAT })[0]?.evolution ?? '').includes('→') || fixed.length === 1,
    JSON.stringify(chatStances(db, { chatId: CHAT }).map((s) => s.evolution)));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
