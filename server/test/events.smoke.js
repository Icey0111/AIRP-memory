// 事件重述判等 (V9) 冒烟测试
//
// 这个文件存在的理由 (一次真实数据丢失换来的):
//   events 的幂等判据长期是"同 chat 同 title", 而 title 曾被写成实例 label。
//   合并抽取每个窗口都从 e1 开始编号 → 第二段剧情里同样叫 e1 的实例被判"已存在",
//   整条事件被**静默丢弃** (实测: 窗口 1 落 2 条, 窗口 2 落 0 条)。
//   V9 把判等键改成: 同 label 同窗口, 或 同 title 同时间点。
//
// 这里钉死四条性质:
//   1) 跨窗口同 label (不同剧情) → 两条都落库 (不许再吞);
//   2) 同窗口重抽 → existed + confirms+1, 不新增行;
//   3) title 与 label 分列存 (描述性标题不再被 label 顶掉);
//   4) 无 label 的子实例不参与判等 (否则两条同为"去"的从句会互相吞并);
//   5) 同 title 但时间点不同 → 视为两次事件 (不是重述)。
// 运行: node test/events.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { extractInstances, persistInstances } from '../src/services/extractionService.js';
import { createLlmClient } from '../src/services/llmClient.js';

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

const CHAT = 'chat-ev';
console.log(`schema_version = ${getSchemaVersion(freshDb())}`);

// ---------- 1) 跨窗口同 label: 绝不互相吞并 ----------
console.log('\n--- 跨窗口同 label (回归: 曾经数据丢失) ---');
{
  const db = freshDb();
  // 两个窗口, 两段完全不同的剧情, 模型都从 e1 开始编号
  const w1 = { people: [{ name: '艾拉' }], instances: [{ label: 'e1', verb_type: '推', title: '艾拉推开酒馆的门' }] };
  const w2 = { people: [{ name: '铁匠' }], instances: [{ label: 'e1', verb_type: '放', title: '铁匠把长剑放在柜台上' }] };

  persistInstances(db, w1, { chatId: CHAT, sourceMessageIds: ['w1-1'] });
  persistInstances(db, w2, { chatId: CHAT, sourceMessageIds: ['w2-1'] });

  const rows = db.prepare('SELECT id, label, title, source_message_ids s FROM events WHERE chat_id = ? ORDER BY id').all(CHAT);
  check('两个窗口各落一条 (不再被 e1 吞掉)', rows.length === 2, JSON.stringify(rows));
  check('两条都留着自己的描述性标题',
    rows[0].title === '艾拉推开酒馆的门' && rows[1].title === '铁匠把长剑放在柜台上',
    JSON.stringify(rows.map((r) => r.title)));
  check('label 单独存列 (title 不再被 e1 顶掉)',
    rows.every((r) => r.label === 'e1'), JSON.stringify(rows.map((r) => r.label)));
  check('来源窗口各自留档 (判等键的一半)',
    rows[0].s === JSON.stringify(['w1-1']) && rows[1].s === JSON.stringify(['w2-1']),
    JSON.stringify(rows.map((r) => r.s)));
}

// ---------- 2) 同窗口重抽 = 重述: 不新增行, confirms+1 ----------
console.log('\n--- 同窗口重抽 ---');
{
  const db = freshDb();
  const win = { people: [{ name: '艾拉' }], instances: [{ label: 'e1', verb_type: '推', title: '艾拉推开酒馆的门' }] };
  const src = ['w1-1', 'w1-2'];
  const a = persistInstances(db, win, { chatId: CHAT, sourceMessageIds: src });
  const b = persistInstances(db, win, { chatId: CHAT, sourceMessageIds: src });

  check('第一次是新建', a.instances[0].existed === false);
  check('第二次标记 existed', b.instances[0].existed === true, JSON.stringify(b.instances[0]));
  const n = db.prepare('SELECT COUNT(*) n FROM events WHERE chat_id = ?').get(CHAT).n;
  check('总行数仍是 1 (重述不新增行)', n === 1, String(n));
  const conf = db.prepare('SELECT confirms c FROM events WHERE chat_id = ?').get(CHAT).c;
  check('confirms 累加到 1 (与属性层/立场层对称)', conf === 1, String(conf));
  check('回报里带上累加后的计数', b.instances[0].confirms === 1, JSON.stringify(b.instances[0]));
}

// ---------- 3) 无 label 的子实例: 不参与判等 ----------
console.log('\n--- 无 label 子实例 ---');
{
  const db = freshDb();
  // 两条从句都没有 label, title 会回落到动词"去" —— 若判等就会互相吞并
  const data = {
    time_point: { label: '第四日' },
    instances: [
      { label: '她的打算', verb_type: '说', source_type: 'narrator', comp: { verb_type: '去', source_type: 'attributed', attitude: '计划' } },
      { label: '她的否认', verb_type: '说', source_type: 'narrator', comp: { verb_type: '去', source_type: 'attributed', attitude: '否认', polarity: '-' } },
    ],
  };
  persistInstances(db, data, { chatId: CHAT, sourceMessageIds: ['x'] });
  const children = db.prepare("SELECT id, title, parent_role FROM events WHERE chat_id = ? AND parent_role = 'comp'").all(CHAT);
  check('两条同为"去"的从句都落库 (不互相吞并)', children.length === 2, JSON.stringify(children));
}

// ---------- 4) 同 title 但时间点不同 = 两次事件 ----------
console.log('\n--- 同 title 不同时间点 ---');
{
  const db = freshDb();
  const mk = (tp) => ({
    time_point: { label: tp },
    instances: [{ label: `推门-${tp}`, verb_type: '推', title: '艾拉推开酒馆的门' }],
  });
  persistInstances(db, mk('第一日'), { chatId: CHAT, sourceMessageIds: ['a'] });
  persistInstances(db, mk('第二日'), { chatId: CHAT, sourceMessageIds: ['b'] });
  const rows = db.prepare('SELECT id, title, time_id FROM events WHERE chat_id = ?').all(CHAT);
  check('同一动作在不同时间点算两次事件 (不是重述)',
    rows.length === 2 && rows[0].time_id !== rows[1].time_id, JSON.stringify(rows));
}

// ---------- 5) 走真实抽取入口: 重述计数不影响记忆写入 ----------
console.log('\n--- 走 extractInstances 入口 ---');
{
  const db = freshDb();
  const mock = JSON.stringify({ people: [{ name: '艾拉' }], instances: [{ label: '酒馆初遇', verb_type: '遇', title: '酒馆初遇' }] });
  const llm = createLlmClient({ provider: 'mock', mockResponse: mock });
  const a = await extractInstances(db, llm, { chatId: CHAT, text: 'x', sourceMessageIds: ['m1'] });
  const b = await extractInstances(db, llm, { chatId: CHAT, text: 'x', sourceMessageIds: ['m1'] });
  check('第一次写事件记忆, 第二次不再重复写',
    a.memoryIds.length === 1 && b.memoryIds.length === 0,
    JSON.stringify({ a: a.memoryIds, b: b.memoryIds }));
  check('第二次标记 existed 且不新增行',
    b.instances.every((i) => i.existed)
    && db.prepare('SELECT COUNT(*) n FROM events WHERE chat_id = ?').get(CHAT).n === 1);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
