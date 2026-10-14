// 合并重复的 main 节点 (用户本人) —— 修既有数据用。
//
// 为什么需要它: main 唯一不变量是 2026-10-14 才加上的。此前的库里可能已经有多个 main
// (实测: 你 / User / 主角 三个), 立场与画像按节点裂成两套, 注入里出现同义两行。
// 本工具把非 canonical 的 main 并进 canonical (id 最小者), 并把同槽位的立场收成一条链。
//
// 用法:
//   node src/cli/merge-mains.js            # 干跑: 打印将要做的每一件事
//   node src/cli/merge-mains.js --apply    # 执行 (单事务; 原节点软删, 不物理删除)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { findMainPerson, mergePersonIntoMain, normalizeStanceSlots } from '../services/entityService.js';

const apply = process.argv.includes('--apply');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig();
const db = openDatabase(path.resolve(root, config.db.path ?? 'data/memory.db'));

console.log(`db: ${db.name}\n`);

const mains = db.prepare(
  "SELECT id, name, aliases, created_at FROM people WHERE is_active = 1 AND person_type = 'main' ORDER BY id"
).all();

if (mains.length === 0) {
  console.log('没有 main 节点 —— 无需合并。');
  process.exit(0);
}
if (mains.length === 1) {
  console.log(`只有一个 main (id ${mains[0].id} ${mains[0].name}) —— 结构合规。`);
} else {
  console.log(`发现 ${mains.length} 个 main (应当只有 1 个):`);
  for (const m of mains) console.log(`  #${m.id} ${m.name}  aliases=${m.aliases}`);
}

const canonical = mains[0];
const others = mains.slice(1);

// 预告每个节点会被重指多少引用 (干跑时也如实打印)
const plan = others.map((m) => {
  const cnt = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    from: m,
    participants: cnt('SELECT COUNT(*) n FROM event_participants WHERE person_id = ?', m.id),
    holder: cnt("SELECT COUNT(*) n FROM stances WHERE holder_id = ? AND holder_type = 'person'", m.id),
    target: cnt("SELECT COUNT(*) n FROM stances WHERE target_id = ? AND target_type = 'person'", m.id),
    chunks: cnt("SELECT COUNT(*) n FROM attribute_chunks WHERE entity_type = 'person' AND entity_id = ?", m.id),
    refs: cnt("SELECT COUNT(*) n FROM memory_entity_refs WHERE entity_type = 'person' AND entity_id = ?", m.id),
    source: cnt('SELECT COUNT(*) n FROM events WHERE source_person_id = ?', m.id),
  };
});

// 合并后会出现"同槽位多条生效立场" —— 预告要收口哪些槽位
const dupSlots = db.prepare(`
  SELECT holder_type, holder_id, target_type, target_id, IFNULL(stance_dimension,'总体') dim, COUNT(*) n
  FROM stances WHERE is_active = 1
  GROUP BY holder_type, holder_id, target_type, target_id, dim HAVING n > 1
`).all();

console.log(`\ncanonical = #${canonical.id} ${canonical.name} (id 最小者, 保留)`);
for (const p of plan) {
  console.log(`  并入 #${p.from.id} ${p.from.name}: 参与者 ${p.participants} · 立场(持/对) ${p.holder}/${p.target}`
    + ` · 观察 ${p.chunks} · 引用桥 ${p.refs} · 归属者 ${p.source}`);
}
console.log(`\n合并后需收口的立场槽位 (同槽位多条生效): ${dupSlots.length} 个`);
for (const s of dupSlots) {
  console.log(`  ${s.holder_type}#${s.holder_id} → ${s.target_type}#${s.target_id} @${s.dim} (${s.n} 条)`);
}

if (!apply) {
  console.log('\n(干跑, 未改动。确认无误后加 --apply 执行)');
  process.exit(0);
}

let merged = [];
let slots = [];
db.transaction(() => {
  for (const o of others) merged.push(mergePersonIntoMain(db, { fromId: o.id, toId: canonical.id }));
  slots = normalizeStanceSlots(db);
})();

console.log('\n已执行:');
for (const m of merged) console.log(`  ${m.from} → ${m.into}: ${JSON.stringify(m.repointed)}`);
console.log(`  立场槽位收口 ${slots.length} 个: ${slots.map((s) => `${s.slot}(保留#${s.kept}, 退休${s.retired.join('/')})`).join(', ') || '无'}`);
const after = db.prepare("SELECT id, name, aliases, person_type, is_active FROM people WHERE person_type='main' ORDER BY id").all();
console.log('\n结果:', JSON.stringify(after));
db.close();
