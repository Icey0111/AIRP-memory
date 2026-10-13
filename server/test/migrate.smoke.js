// 迁移链冒烟测试: 验证 V5 -> V6 的升级路径与全新引导路径产出一致的结构
// 运行: node test/migrate.smoke.js
//
// 这个文件存在的理由 (核心命题):
//   数据库有两个入口 —— ①旧库跑迁移链 ②全新库跑 schema.sql。
//   两者必须产出**同一套结构**, 否则"新装用户"和"老用户升级"会活在两个世界,
//   而这种不一致通常在很久以后才以诡异 bug 的形式暴露。
//   本测试把两个入口的结果做逐列比对, 并钉死迁移的四项承诺:
//     1) 旧数据零漂移 (全部自动成为 narrator 事实, 事件/边一行不少);
//     2) 归属命题与事实经视图分路, 不泄漏;
//     3) event_links 的 relation 词表真的扩了 (条件/择一可用, 非法值仍被拒);
//     4) 取值元素层已建立。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion, LATEST_SCHEMA_VERSION } from '../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const dbDir = path.join(projectRoot, 'db');
const v5Fixture = path.join(here, 'fixtures', 'schema-v5.sql');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-migrate-'));

/** 建一个"旧库": 用冻结的 v5 快照引导, 再塞入真实业务数据 */
function buildV5Database() {
  const dir = path.join(tmpRoot, 'v5');
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.copyFileSync(v5Fixture, path.join(dir, 'schema.sql'));
  for (const f of fs.readdirSync(path.join(dbDir, 'migrations'))) {
    fs.copyFileSync(path.join(dbDir, 'migrations', f), path.join(dir, 'migrations', f));
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf-8'));

  const ts = 1700000000;
  const insEvent = db.prepare(`
    INSERT INTO events (title, process, cause_text, result_text, chat_id, created_at, updated_at)
    VALUES (?, ?, '', '', 'chat-old', ?, ?)
  `);
  insEvent.run('酒馆初遇', '为躲雨推门而入', ts, ts);
  insEvent.run('卷宗易手', '递出卷宗', ts, ts);
  insEvent.run('旧事件三', '', ts, ts);
  db.prepare('INSERT INTO event_links (from_id, to_id, relation, created_at) VALUES (1, 2, ?, ?)')
    .run('caused', ts);
  db.prepare('INSERT INTO event_links (from_id, to_id, relation, created_at) VALUES (2, 3, ?, ?)')
    .run('contradicts', ts);
  db.prepare(`INSERT INTO memories (type, content, keywords, importance, scope, chat_id, created_at, updated_at)
              VALUES ('fact', '旧记忆', '', 0.5, 'chat', 'chat-old', ?, ?)`).run(ts, ts);
  db.prepare(`INSERT INTO people (name, aliases, person_type, created_at, updated_at)
              VALUES ('艾拉', '["小艾"]', 'main', ?, ?)`).run(ts, ts);

  return { db, dir };
}

console.log('\n--- 入口一: 旧库 (v5 快照) 跑迁移链 ---');
const { db: oldDb, dir: migDir } = buildV5Database();
check('旧库引导后为 v5', getSchemaVersion(oldDb) === 5, String(getSchemaVersion(oldDb)));
const eventsBefore = oldDb.prepare('SELECT COUNT(*) n FROM events').get().n;
const linksBefore = oldDb.prepare('SELECT COUNT(*) n FROM event_links').get().n;

const version = migrate(oldDb, migDir, () => {});
check('迁移后 schema_version=6', version === 6 && getSchemaVersion(oldDb) === 6, String(version));
check('事件一行不少 (迁移前 3)', oldDb.prepare('SELECT COUNT(*) n FROM events').get().n === eventsBefore
  && eventsBefore === 3, `before=${eventsBefore}`);
check('因果边一行不少 (迁移前 2)', oldDb.prepare('SELECT COUNT(*) n FROM event_links').get().n === linksBefore
  && linksBefore === 2, `before=${linksBefore}`);

// 零漂移: 旧行默认 narrator + asserted, 于是全部落在事实视图里
const narr = oldDb.prepare("SELECT COUNT(*) n FROM events WHERE source_type='narrator'").get().n;
check('旧数据零漂移: 全部自动成为 narrator 断言', narr === 3, `narrator=${narr}`);
check('事实视图行数 = 事件总数', oldDb.prepare('SELECT COUNT(*) n FROM v_facts').get().n === 3);
check('命题视图此时为空', oldDb.prepare('SELECT COUNT(*) n FROM v_propositions').get().n === 0);
check('旧行 status 默认 asserted, polarity 默认 +',
  oldDb.prepare("SELECT COUNT(*) n FROM events WHERE status='asserted' AND polarity='+'").get().n === 3);

console.log('\n--- 视图分路: 归属命题不泄漏进事实层 ---');
const ts = 1700000100;
oldDb.prepare(`
  INSERT INTO events (title, chat_id, created_at, updated_at,
                      verb_type, source_type, attitude, source_person_id, tense, status)
  VALUES ('去镇上买草药', 'chat-old', ?, ?, '去', 'attributed', '说', 1, 'future', 'pending')
`).run(ts, ts);
check('propositions 视图收录归属命题', oldDb.prepare('SELECT COUNT(*) n FROM v_propositions').get().n === 1);
check('facts 视图不含归属命题 (仍是 3)', oldDb.prepare('SELECT COUNT(*) n FROM v_facts').get().n === 3);
check('命题三轴可落库并读回 (attributed/说/future/pending)',
  (() => {
    const r = oldDb.prepare("SELECT source_type, attitude, tense, status FROM events WHERE verb_type='去'").get();
    return r.source_type === 'attributed' && r.attitude === '说' && r.tense === 'future' && r.status === 'pending';
  })());

console.log('\n--- 嵌套引述与对齐指针 ---');
const parentId = oldDb.prepare("SELECT id FROM events WHERE verb_type='' AND title='酒馆初遇'").get().id;
const propId = oldDb.prepare("SELECT id FROM events WHERE verb_type='去'").get().id;
oldDb.prepare('UPDATE events SET parent_instance_id = ?, parent_role = ? WHERE id = ?')
  .run(parentId, 'comp', propId);
check('命题可挂在父实例下 (comp, 深度 1)',
  oldDb.prepare('SELECT parent_instance_id, parent_role FROM events WHERE id = ?').get(propId).parent_role === 'comp');
oldDb.prepare('UPDATE events SET status = ?, aligned_instance_id = ? WHERE id = ?')
  .run('realized', parentId, propId);
check('对齐指针可写入 (status=realized + aligned_instance_id)',
  oldDb.prepare('SELECT status, aligned_instance_id FROM events WHERE id = ?').get(propId).aligned_instance_id === parentId);

console.log('\n--- 边表重建: 词表扩展且约束仍生效 ---');
oldDb.prepare('INSERT INTO event_links (from_id, to_id, relation, created_at) VALUES (1, 3, ?, ?)')
  .run('conditional', ts);
check('新增条件边 conditional 可写入',
  oldDb.prepare("SELECT COUNT(*) n FROM event_links WHERE relation='conditional'").get().n === 1);
oldDb.prepare('INSERT INTO event_links (from_id, to_id, relation, created_at) VALUES (3, 1, ?, ?)')
  .run('alternative', ts);
check('新增择一边 alternative 可写入',
  oldDb.prepare("SELECT COUNT(*) n FROM event_links WHERE relation='alternative'").get().n === 1);
check('非法 relation 仍被 CHECK 拒绝',
  (() => {
    try {
      oldDb.prepare('INSERT INTO event_links (from_id, to_id, relation, created_at) VALUES (1, 2, ?, ?)')
        .run('乱写的边', ts);
      return false;
    } catch { return true; }
  })());
check('旧的两类边未受影响 (caused/contradicts 各 1)',
  oldDb.prepare("SELECT COUNT(*) n FROM event_links WHERE relation IN ('caused','contradicts')").get().n === 2);

console.log('\n--- 取值元素层 ---');
check('value_nodes 表已建立',
  oldDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='value_nodes'").get() != null);
oldDb.prepare(`INSERT INTO value_nodes (name, aliases, kind, created_at, updated_at)
               VALUES ('信任', '["信赖","信服"]', 'stance_type', ?, ?)`).run(ts, ts);
check('取值节点可写入 (含别名)',
  oldDb.prepare("SELECT aliases FROM value_nodes WHERE name='信任'").get().aliases === '["信赖","信服"]');
check('同域同名唯一 (第二行被 UNIQUE 拒绝)',
  (() => {
    try {
      oldDb.prepare(`INSERT INTO value_nodes (name, kind, created_at, updated_at)
                     VALUES ('信任', 'stance_type', ?, ?)`).run(ts, ts);
      return false;
    } catch { return true; }
  })());
check('同名不同域可并存 (信任/aspect 可建)',
  (() => {
    oldDb.prepare(`INSERT INTO value_nodes (name, kind, created_at, updated_at)
                   VALUES ('信任', 'aspect', ?, ?)`).run(ts, ts);
    return oldDb.prepare("SELECT COUNT(*) n FROM value_nodes WHERE name='信任'").get().n === 2;
  })());

console.log('\n--- 入口二: 全新库跑 schema.sql ---');
const freshDb = new Database(':memory:');
freshDb.pragma('foreign_keys = ON');
fs.copyFileSync(path.join(dbDir, 'schema.sql'), path.join(migDir, 'schema.sql'));
migrate(freshDb, migDir, () => {});
check('全新引导即为 v6', getSchemaVersion(freshDb) === 6, String(getSchemaVersion(freshDb)));
check('全新库也带 LATEST_SCHEMA_VERSION 一致', LATEST_SCHEMA_VERSION === 6);
check('全新库同样有视图', freshDb.prepare('SELECT COUNT(*) n FROM v_facts').get().n === 0
  && freshDb.prepare('SELECT COUNT(*) n FROM v_propositions').get().n === 0);
check('全新库同样有 value_nodes',
  freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='value_nodes'").get() != null);

console.log('\n--- 两个入口结构等价 (本测试的核心断言) ---');
const cols = (db) => db.prepare('PRAGMA table_info(events)').all()
  .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).sort();
check('events 列定义逐列一致 (迁移链 vs schema.sql)',
  JSON.stringify(cols(oldDb)) === JSON.stringify(cols(freshDb)),
  `\n    迁移: ${cols(oldDb).join(' | ')}\n    新装: ${cols(freshDb).join(' | ')}`);

const objects = (db) => db.prepare(
  "SELECT type, name FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
).all().map((r) => `${r.type}:${r.name}`);
check('表/视图/索引清单一致',
  JSON.stringify(objects(oldDb)) === JSON.stringify(objects(freshDb)),
  `\n    迁移多出: ${objects(oldDb).filter((x) => !objects(freshDb).includes(x)).join(', ')}`
  + `\n    新装多出: ${objects(freshDb).filter((x) => !objects(oldDb).includes(x)).join(', ')}`);

// 注意: ALTER TABLE ... RENAME 会让 SQLite 重写 DDL 文本 (表名变成带引号的 "event_links"),
// 语义等价但字符串不等 —— 故比对前剥掉标识符引号。不归一化的话这里必然误报。
const linksSql = (db) => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='event_links'"
).get().sql.replace(/\s+/g, ' ').replace(/"/g, '');
check('event_links 的 CHECK 词表一致 (含 conditional/alternative)',
  linksSql(oldDb) === linksSql(freshDb)
  && linksSql(oldDb).includes('conditional') && linksSql(oldDb).includes('alternative'));

console.log('\n--- 高版本库拒绝启动 ---');
const futureDb = new Database(':memory:');
futureDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
  + "INSERT INTO meta VALUES ('schema_version','99')");
check('schema_version 高于服务支持时抛错',
  (() => {
    try { migrate(futureDb, migDir, () => {}); return false; } catch (e) { return /高于本服务支持/.test(e.message); }
  })());

oldDb.close();
freshDb.close();
futureDb.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
