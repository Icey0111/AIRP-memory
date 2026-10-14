// 会话记忆体检: 给一个 chatId, 只读地打印"这一轮/这一段到底织进去了什么"。
//
// 用途: 验证"每轮编织"的真实质量 —— 不看这个就只能凭感觉判断。
// 关注四个信号:
//   ① 三层是否都在产出 (stances 常为 0 = 合并 prompt 那边有偏向)
//   ② 锚点命中率 (观察/立场挂到触发它的事件上的比例; 0% = 模型没填 event 键)
//   ③ 有没有重复堆积 (V9 判等生效的证明: 同标题多行 = 没生效)
//   ④ 注入里各段实际条数 (记忆有没有真的进到 prompt)
//
// 用法:
//   node check-session.mjs "<chatId>"                只看库
//   node check-session.mjs "<chatId>" --context "艾拉"  连注入一起看 (需服务在跑)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 脚本住在仓库根 (与 check-contract / check-static 同级), 但 better-sqlite3 装在 server/ 下
const Database = createRequire(path.join(HERE, 'server', 'package.json'))('better-sqlite3');
const DB = path.join(HERE, 'server', 'data', 'memory.db');
const BASE = process.env.AIRP_SERVER_URL ?? 'http://127.0.0.1:7780';

const [chatId, ...rest] = process.argv.slice(2);
if (!chatId) {
  console.error('用法: node check-session.mjs "<chatId>" [--context "<查询词>"]');
  process.exit(2);
}
const ctxIdx = rest.indexOf('--context');
const query = ctxIdx >= 0 ? (rest[ctxIdx + 1] ?? '') : null;

const db = new Database(DB, { readonly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

console.log(`\n=== 会话体检: ${chatId} ===`);
const schema = one("SELECT value v FROM meta WHERE key='schema_version'")?.v;
console.log(`schema=v${schema}  db=${path.relative(HERE, DB)}`);

// ---------- 一阶记忆 ----------
const mem = one('SELECT COUNT(*) n FROM memories WHERE chat_id = ?', chatId).n;
console.log(`\n--- 一阶记忆 (${mem}) ---`);
for (const m of all(`SELECT type, in_world_time t, substr(content,1,52) c FROM memories
  WHERE chat_id = ? ORDER BY id DESC LIMIT 6`, chatId)) {
  console.log(`  [${m.type}${m.t ? ` ${m.t}` : ''}] ${m.c}`);
}

// ---------- 事件 (含 V9 判等信号) ----------
const ev = all(`SELECT id, label, title, verb_type, source_type, status, confirms,
  source_message_ids s, time_id FROM events
  WHERE chat_id = ? AND parent_instance_id IS NULL ORDER BY id`, chatId);
console.log(`\n--- 事件 (${ev.length} 条顶层) ---`);
for (const e of ev.slice(-8)) {
  const flag = e.confirms > 0 ? ` ×${e.confirms + 1}(重述)` : '';
  console.log(`  #${e.id} [${e.label ?? '-'}] ${e.title} · ${e.verb_type}/${e.source_type}/${e.status}${flag}`);
}
const kids = one('SELECT COUNT(*) n FROM events WHERE chat_id = ? AND parent_instance_id IS NOT NULL', chatId).n;
console.log(`  (另有从句/条件前件 ${kids} 条)`);

// 重复候选: 同标题多行 (V9 生效则应为 0)
const dupes = all(`SELECT title, COUNT(*) n FROM events WHERE chat_id = ? AND is_active = 1
  GROUP BY title HAVING n > 1`, chatId);
console.log(dupes.length === 0
  ? '  ✓ 无同标题重复行 (V9 判等生效)'
  : `  ⚠ 同标题多行: ${dupes.map((d) => `${d.title}×${d.n}`).join(', ')}`);

// ---------- 观察块 ----------
const ch = all(`SELECT id, entity_type et, entity_id, aspect, substr(content,1,34) c,
  confirms, valid_from_event_id v FROM attribute_chunks
  WHERE chat_id = ? AND is_active = 1 ORDER BY id`, chatId);
console.log(`\n--- 观察块 (${ch.length} 条生效) ---`);
for (const c of ch.slice(-8)) {
  const anchor = c.v ? `→事件#${c.v}` : '→无锚点';
  const rep = c.confirms > 0 ? ` ×${c.confirms + 1}` : '';
  console.log(`  [${c.aspect}] ${c.c}${rep} ${anchor}`);
}

// ---------- 立场 ----------
const st = all(`SELECT s.id, s.stance_type, s.intensity, s.valid_from_event_id v,
  hp.name hn, tp.name tn FROM stances s
  LEFT JOIN people hp ON s.holder_type='person' AND hp.id = s.holder_id
  LEFT JOIN people tp ON s.target_type='person' AND tp.id = s.target_id
  WHERE s.chat_id = ? AND s.is_active = 1 ORDER BY s.id`, chatId);
console.log(`\n--- 立场 (${st.length} 条生效) ---`);
for (const s of st) {
  console.log(`  ${s.hn ?? '?'} → ${s.tn ?? '?'}: ${s.stance_type} (${s.intensity}) ${s.v ? `→事件#${s.v}` : '→无锚点'}`);
}

// ---------- 质量指标 ----------
const anchored = (rows) => rows.filter((r) => r.v != null).length;
const pct = (a, b) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);
console.log('\n--- 质量指标 ---');
console.log(`  锚点命中: 观察 ${anchored(ch)}/${ch.length} (${pct(anchored(ch), ch.length)})  `
  + `立场 ${anchored(st)}/${st.length} (${pct(anchored(st), st.length)})`);
console.log(`  三层产出: 事件 ${ev.length > 0 ? '✓' : '✗'}  观察 ${ch.length > 0 ? '✓' : '✗'}  立场 ${st.length > 0 ? '✓' : '✗'}`);
if (ch.length > 0 && st.length === 0) {
  console.log('  ⚠ 有观察但零立场: 合并 prompt 的立场层可能被弱化 —— 试试把 stances 段提到 observations 之前');
}
const people = all(`SELECT name, person_type FROM people WHERE id IN (
  SELECT person_id FROM event_participants WHERE event_id IN
  (SELECT id FROM events WHERE chat_id = ?))`, chatId);
console.log(`  涉及人物: ${people.map((p) => `${p.name}(${p.person_type})`).join(', ') || '—'}`);

// ---------- 注入预览 (可选) ----------
if (query !== null) {
  console.log('\n--- 注入预览 (/api/context) ---');
  try {
    const res = await fetch(`${BASE}/api/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, chatId }),
    });
    const c = await res.json();
    if (!c.ok) throw new Error(c.error ?? 'unknown');
    const headers = ['【角色画像】', '【关系立场】', '【关键实体】', '【前情提要】', '【事件时间线】', '【待兑现】', '【相关记忆】', '【相关细节】'];
    console.log(`  形态=${c.injectionMode} 检索预算=${c.usedTokens}/${c.tokenBudget}`);
    console.log(`  出现的段: ${headers.filter((h) => c.text.includes(h)).join(' ') || '(空)'}`);
    console.log(`  计数: 画像 ${c.profileCount}/${c.profileTotal} · 立场 ${c.stanceCount} · 实体 ${c.entityCount}`
      + ` · 时间线 ${c.timelineCount} · 待兑现 ${c.pendingCount} · 记忆命中 ${c.hitCount} · 细节命中 ${c.chunkHitCount}`);
    if (c.text) {
      console.log('  --- 注入前 12 行 ---');
      for (const line of c.text.split('\n').slice(0, 12)) console.log(`  | ${line.slice(0, 110)}`);
    }
  } catch (err) {
    console.log(`  跳过 (服务不可达或出错: ${err.message}) —— 记忆服务没起时只跑库内体检`);
  }
}

db.close();
console.log('');
