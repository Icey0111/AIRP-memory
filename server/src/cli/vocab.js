// 词表工具 (V10, docs/vocabulary-layer.md) —— 看复用度, 审待审队列, 归并同义写法。
//
// 为什么需要人工入口: 归一有两半。
//   机械的一半在落库前自动做 (别名命中 -> 规范词; 跨语言写法 agent→发起者, 外貌→appearance),
//   另一半**不该自动做** —— 「拦截盘查」该并进「问」还是「盘查」? 「守护」算不算「亲近」?
//   自动拆词/合并猜错比不猜更有害 (归并不可逆, 与实体归并同一条纪律), 所以它们进待审队列,
//   由这个工具给人看、给人并。
//
// 用法:
//   node src/cli/vocab.js report [--kind predicate]   # 复用度体检 + 待审队列 (默认全部域)
//   node src/cli/vocab.js check [--apply]             # 漂移检查 + 回填空指针 + 并入旧别名元素
//   node src/cli/vocab.js merge <kind> <from> <to> [--apply]   # 归并 (改指针 + 并别名)
//   node src/cli/vocab.js seed                        # 重灌种子词表 (幂等; 升级后补新别名)
// 任意子命令都接受 --db <路径> 指向别的库 (核对备份/迁移副本时用, 不动正在跑的库)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { VOCABULARY, VOCABULARY_WORDS } from '../domain/constants.js';
import {
  auditVocabulary, listVocabulary, mergeVocabulary, normalizeWord, seedVocabulary,
  backfillVocabulary, VOCAB_KINDS,
} from '../services/vocabularyService.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'report';
const apply = argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig();
const db = openDatabase(path.resolve(root, flag('--db') ?? config.db.path ?? 'data/memory.db'));
console.log(`db: ${db.name}\n`);

const num = (n) => String(n).padStart(3);
const labelOf = (kind) => VOCABULARY.kinds.find((k) => k.value === kind)?.label ?? kind;

if (cmd === 'report') {
  const only = flag('--kind');
  const audit = auditVocabulary(db, { kind: only });
  console.log('=== 复用度 (本次迁移要解决的指标) ===');
  for (const [kind, s] of Object.entries(audit.kinds)) {
    console.log(`  ${labelOf(kind).padEnd(6)} 元素 ${num(s.nodes)} | 被引用 ${num(s.rows)} 行 | 复用度 ${String(s.reuse).padEnd(5)}`
      + ` | 被复用元素 ${num(s.reusedNodes)} | 未接指针 ${num(s.pendingRows)}`);
  }
  console.log('\n=== 待审队列 (词表外的新词, 按复用度) ===');
  console.log('  这些词是抽取时新造的: 挂上位类或并进规范词都要人看一眼 (归并不可逆)');
  for (const n of audit.needsReview.slice(0, 40)) {
    console.log(`  ${labelOf(n.kind).padEnd(6)} ${String(n.name).padEnd(12)} ×${n.count}`);
  }
  if (!audit.needsReview.length) console.log('  (空 —— 全部落在词表内)');
  if (audit.orphan.length) {
    console.log(`\n=== 孤儿元素 (抽出来但没有任何指针, ${audit.orphan.length} 个) ===`);
    for (const o of audit.orphan.slice(0, 20)) console.log(`  ${labelOf(o.kind).padEnd(6)} ${o.name} (${o.status})`);
  }
  console.log(`\n漂移 (文本缓存 != 指针): ${audit.drift.length} ${audit.drift.length ? '-> 跑 vocab.js check --apply' : '✓'}`);
  console.log('\n各域规范词数量:', VOCAB_KINDS.map((k) => `${labelOf(k)} ${VOCABULARY_WORDS[k].length}`).join(' · '));
} else if (cmd === 'check') {
  const audit = auditVocabulary(db);
  const pending = Object.entries(audit.kinds).reduce((n, [, s]) => n + s.pendingRows, 0);
  console.log(`漂移 ${audit.drift.length} 行 · 未接指针 ${pending} 行 · 孤儿 ${audit.orphan.length} 个`);
  if (!apply) {
    console.log('\n(干跑, 未改动。加 --apply 执行: 归一空指针 + 并入旧别名元素)');
  } else {
    const seeded = seedVocabulary(db);
    const bf = backfillVocabulary(db);
    console.log(`\n已执行: 种子 新建${seeded.created}/更新${seeded.updated}`
      + ` · 回填 ${JSON.stringify(bf.filled)} · 新建待审 ${bf.created.length} · 并入 ${bf.merged.length}`);
    const after = auditVocabulary(db);
    console.log(`复查: 漂移 ${after.drift.length} · 待审 ${after.needsReview.length} 个元素`);
  }
} else if (cmd === 'merge') {
  const [, kind, fromArg, toArg] = argv;
  if (!VOCAB_KINDS.includes(kind)) throw new Error(`kind 必须是 ${VOCAB_KINDS.join('/')} 之一`);
  const resolve = (arg) => {
    if (/^\d+$/.test(arg)) {
      return db.prepare('SELECT * FROM value_nodes WHERE id = ? AND kind = ?').get(Number(arg), kind);
    }
    const norm = normalizeWord(kind, arg);
    return db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND name = ?').get(kind, norm?.word ?? arg);
  };
  const from = resolve(fromArg);
  const to = resolve(toArg);
  if (!from || !to) throw new Error(`找不到元素: ${!from ? fromArg : toArg} (kind=${kind})`);
  const shown = listVocabulary(db, { kind }).filter((v) => [from.id, to.id].includes(v.id));
  console.log(`归并 ${labelOf(kind)}: 「${from.name}」 -> 「${to.name}」`);
  for (const v of shown) console.log(`  #${v.id} ${v.name} 复用度 ${v.count} 写法 ${JSON.stringify(v.aliases)}`);
  if (!apply) {
    console.log('\n(干跑, 未改动。归并**不可逆**, 确认后加 --apply)');
  } else {
    const r = mergeVocabulary(db, kind, from.id, to.id);
    console.log(`\n已归并: ${r.from} -> ${r.to}, 改指针 ${JSON.stringify(r.moved)}`);
    console.log(`「${r.from}」已并入 ${r.to} 的写法: ${JSON.stringify(r.aliases)}`);
  }
} else if (cmd === 'seed') {
  const r = seedVocabulary(db);
  console.log(`种子词表: 新建 ${r.created} 个元素, 补别名/上位类 ${r.updated} 个`);
  const byKind = db.prepare("SELECT kind, count(*) c FROM value_nodes WHERE source='seed' GROUP BY kind").all();
  console.log('按域:', byKind.map((x) => `${labelOf(x.kind)} ${x.c}`).join(' · '));
} else {
  console.log('用法: report [--kind <域>] | check [--apply] | merge <域> <源> <目标> [--apply] | seed');
}
db.close();
