// 词表层服务 (V10, 依据 docs/vocabulary-layer.md)
//
// **元素先于指针** (V7 就写在 value_nodes 上的那条原则) 在这里从"立场/属性"扩到
// 谓词 / 题元角色 / 情态 / 从句角色 / 对齐状态 —— 七个域全部落成取值元素, 实例只存 id。
//
// 为什么必须做 (实测, 不是洁癖):
//   谓词不成词表 => "同一个谓词被 N 个实例复用"在库里不存在 (40 条实例 33 个谓词,
//   复用度 1.21) => 命题对齐的硬条件"同动词"永远不成立 => **真假判定一次都没生效**
//   (10 条归属命题, 判定成功 0 条)。复用度不是审美指标, 是对齐算法能不能工作的前提。
//
// 归一是**确定性**的, 而且发生在落库前, 不靠 prompt 自觉:
//   ① 别名命中 (含跨语言写法: agent→发起者, appearance→外貌) -> 规范词
//   ② 未命中 -> 新建元素并标 needs_review (宁可不并: 多一个节点不破坏指针语义,
//      错并会抹掉刻意的区分, 而且不可逆)
//
// 本文件只有一份"指针地图" (POINTERS): 落库、回填、审计、归并、漂移检查全由它驱动 ——
// 加一个域只改一处。
import { now } from '../utils/text.js';
import { VOCABULARY, VOCABULARY_WORDS, VERB_LAYER } from '../domain/constants.js';
import { findValue } from './valueService.js';

/** 域 -> 指针列 (fk) 与同义文本列 (text)。文本列是**归一后的词**缓存, 与 fk 同步写 */
const POINTERS = {
  predicate: [{ table: 'events', fk: 'predicate_id', text: 'verb_type' }],
  // 题元角色的文本列在主键里 (event_id, person_id, role): 归并时可能撞主键, 要 OR IGNORE
  role: [{ table: 'event_participants', fk: 'role_id', text: 'role', pkCollision: true }],
  attitude: [{ table: 'events', fk: 'attitude_id', text: 'attitude' }],
  clause: [{ table: 'events', fk: 'clause_id', text: 'parent_role' }],
  status: [{ table: 'events', fk: 'status_id', text: 'status' }],
  aspect: [{ table: 'attribute_chunks', fk: 'aspect_id', text: 'aspect' }],
  stance_type: [{ table: 'stances', fk: 'stance_type_id', text: 'stance_type' }],
  // 时段是**指针-only**: time_points.label 是世界内时刻的名字 ("第三夜, 暴雨"),
  // 不是归一后的词 —— 它没有文本缓存, 所以不参与漂移检查, 也不能被归并改写
  time: [{ table: 'time_points', fk: 'period_id', text: null, from: 'label', derive: 'period' }],
};
export const VOCAB_KINDS = VOCABULARY.kinds.map((k) => k.value);

/** 归一化的**表面**处理: NFKC -> 折叠空白 -> 去首尾标点。判等键再转小写 */
export function normalizeSurface(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’()（）[\]【】,，.。;；:：!！?？~～\-—]+/, '')
    .replace(/[\s"'“”‘’()（）[\]【】,，。;；:：!！?？~～\-—]+$/, '')
    .trim();
}
const key = (s) => normalizeSurface(s).toLowerCase();

// ---- 别名索引 (载入时把 规范词->别名 反转成 别名->规范词; 规范词优先) ----
const ALIAS_INDEX = new Map();
for (const kind of VOCAB_KINDS) {
  const m = new Map();
  for (const w of VOCABULARY_WORDS[kind] ?? []) m.set(key(w), w);
  for (const [canon, aliases] of Object.entries(VOCABULARY.aliases[kind] ?? {})) {
    for (const a of [canon, ...aliases]) if (!m.has(key(a))) m.set(key(a), canon);
  }
  ALIAS_INDEX.set(kind, m);
}
const PARENT_OF = new Map(Object.entries(VOCABULARY.predicateParents));
const TIME_PARENT_OF = new Map(Object.entries(VOCABULARY.timeParents));
const CANON = new Map(VOCAB_KINDS.map((k) => [k, new Set((VOCABULARY_WORDS[k] ?? []).map(key))]));

/**
 * 纯函数: 把一个自由词归一到规范词 (可在测试里单独钉住)。
 * @returns {{word:string, surface:string, hit:boolean, canonical:boolean}|null}
 *   hit=true 表示命中词表(或别名) -> word 是规范词; hit=false 表示词表外的新词 -> 待审
 */
export function normalizeWord(kind, raw) {
  const surface = normalizeSurface(raw);
  if (!surface) return null;
  const hit = ALIAS_INDEX.get(kind)?.get(key(surface));
  if (hit) return { word: hit, surface, hit: true, canonical: true };
  return { word: surface, surface, hit: false, canonical: CANON.get(kind)?.has(key(surface)) ?? false };
}

/** 谓词上位类 (抽象到可高度复用的那一层): 具体动词 -> 言语/感知/位移/… */
export function predicateParentOf(word) {
  return PARENT_OF.get(normalizeSurface(word)) ?? null;
}

/** 时段上位类: 具体时段 -> 昼 / 夜 */
export function timeParentOf(word) {
  return TIME_PARENT_OF.get(normalizeSurface(word)) ?? null;
}

/** 规范词 -> 上位类名 (按域分派) */
const parentNameOf = (kind, word) => (kind === 'predicate' ? predicateParentOf(word)
  : kind === 'time' ? timeParentOf(word) : null);

/**
 * 把一个**世界内时间标签**拆成 时段 + 修饰语 (纯函数, 确定性):
 *
 *   "夜晚，深渊暗潮侵袭之时"  -> { period:'夜',   qualifier:'深渊暗潮侵袭之时', head:'夜晚' }
 *   "暮色中，临近戌时三刻落闸" -> { period:'黄昏', qualifier:'临近戌时三刻落闸', head:'暮色中' }
 *   "第三夜"                -> { period:'夜',   qualifier:'', head:'第三夜', suffix:true }
 *   "血月之夜"              -> { period:'夜',   qualifier:'', head:'血月之夜', suffix:true }
 *   "第三章"                -> { period:null,  qualifier:'', head:'第三章' }
 *
 * 只做机械拆分: 按标点切第一段 -> 查时段词表 (含别名) -> 查不到就看**词尾**是不是时段词
 * (第三夜 / 血月之夜)。判断留给人 —— 抽不出时段词的元素进待审队列, 绝不硬塞。
 */
export function parseTimeLabel(raw) {
  const source = String(raw ?? '').trim();
  const full = normalizeSurface(source);
  if (!full) return null;
  const parts = full.split(/[，,、；;·/／\s]+/).filter(Boolean);
  const head = parts[0] ?? full;
  const qualifier = parts.slice(1).join(' ');
  const direct = normalizeWord('time', head);
  // full 回传**原句** (只做了 trim): note 里存的是人写的那句, 标点不该被 NFKC 换掉
  if (direct?.hit) return { period: direct.word, qualifier, head, full: source, suffix: false };
  // 词尾命中: "第三夜" / "血月之夜" —— 序数或修饰 + 时段词
  for (const w of VOCABULARY_WORDS.time) {
    if (w.length <= 2 && head.length > w.length && head.endsWith(w)) {
      const el = normalizeWord('time', w);
      if (el?.hit) return { period: el.word, qualifier, head, full: source, suffix: true };
    }
  }
  return { period: null, qualifier, head, full: source, suffix: false };
}

// ---------------- 种子词表 (每次启动灌一遍, 幂等; 让服务升级能带上新别名) ----------------
function parseAliases(raw) {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
const glossOf = (kind, word) => {
  if (kind === 'predicate') return predicateParentOf(word) ? `上位类: ${predicateParentOf(word)}` : '';
  if (kind === 'time') return timeParentOf(word) ? `上位类: ${timeParentOf(word)}` : '';
  if (kind === 'status') return VERB_LAYER.statuses.find((s) => s.value === word)?.label ?? '';
  if (kind === 'attitude') return VERB_LAYER.attitudes.find((a) => a.value === word)?.label ?? '';
  if (kind === 'clause') return VERB_LAYER.parentRoles.find((r) => r.value === word)?.label ?? '';
  if (kind === 'role') return VERB_LAYER.thematicRoles.find((r) => r.value === word)?.label ?? '';
  return '';
};

/**
 * 灌种子词表 (幂等)。已存在的元素: 补别名、补上位类、标回 seed/ok —— **不删任何东西**。
 * @returns {{created:number, updated:number}}
 */
export function seedVocabulary(db) {
  const ts = now();
  const select = db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND name = ?');
  const insert = db.prepare(`INSERT INTO value_nodes
    (name, aliases, kind, parent_id, gloss, source, status, note, is_active, created_at, updated_at)
    VALUES (@name, @aliases, @kind, @parentId, @gloss, 'seed', 'ok', '', 1, @ts, @ts)`);
  const update = db.prepare(`UPDATE value_nodes
     SET aliases = @aliases, parent_id = @parentId, gloss = @gloss, source = 'seed', status = 'ok',
         is_active = 1, updated_at = @ts WHERE id = @id`);
  let created = 0, updated = 0;

  const upsert = (kind, word, aliases, parentName) => {
    // 上位类名与自身同名 (= 它自己就是类) -> 不挂父节点; 否则会写出自己指向自己的环
    const parentId = parentName && parentName !== word
      ? (select.get(kind, parentName)?.id ?? null)
      : null;
    const existing = select.get(kind, word);
    if (!existing) {
      insert.run({ name: word, aliases: JSON.stringify(aliases), kind, parentId, gloss: glossOf(kind, word), ts });
      created++;
      return;
    }
    const merged = [...new Set([...parseAliases(existing.aliases), ...aliases])].filter((a) => a && a !== word);
    // 自环视为脏数据, 顺手清掉 (曾经把"类名映射到自身"写成 parent_id = 自己)
    const prevParent = existing.parent_id === existing.id ? null : existing.parent_id;
    const nextParent = prevParent ?? parentId;
    const nextGloss = existing.gloss || glossOf(kind, word);
    if (JSON.stringify(merged) !== existing.aliases || nextParent !== existing.parent_id
      || nextGloss !== existing.gloss || existing.source !== 'seed' || existing.status !== 'ok'
      || existing.is_active !== 1) {
      update.run({ id: existing.id, aliases: JSON.stringify(merged), parentId: nextParent, gloss: nextGloss, ts });
      updated++;
    }
  };

  // 上位类先建 (叶子的 parent_id 指向它们)
  for (const cls of VOCABULARY.predicateClasses) upsert('predicate', cls, [], null);
  for (const cls of VOCABULARY.timeClasses) upsert('time', cls, [], null);
  for (const kind of VOCAB_KINDS) {
    for (const word of VOCABULARY_WORDS[kind] ?? []) {
      upsert(kind, word, VOCABULARY.aliases[kind]?.[word] ?? [], parentNameOf(kind, word));
    }
  }
  return { created, updated };
}

// ---------------- 归一 + 落库 (写入路径唯一入口) ----------------
/**
 * 归一一个自由词并拿到**元素 id**。词表外的词会新建元素并标 needs_review (绝不静默丢弃)。
 * @returns {{id:number, word:string, created:boolean, needsReview:boolean, hit:boolean}|null}
 */
export function ensureVocabulary(db, kind, raw, { source = 'extracted', gloss = '', note = '' } = {}) {
  const norm = normalizeWord(kind, raw);
  if (!norm) return null;
  const found = findValue(db, { name: norm.word, kind });
  if (found) {
    // 旧库遗留的元素 (迁移前 findOrCreateValue 随手建的) 从没被审过: 名字不在规范词表里
    // 就如实标成待审 —— 否则"待审队列"会因为"它早就在库里"而漏掉最该审的那批
    if (found.source !== 'seed' && found.status === 'ok' && !CANON.get(kind)?.has(key(found.name))) {
      db.prepare("UPDATE value_nodes SET status = 'needs_review', note = ?, updated_at = ? WHERE id = ?")
        .run(note || 'v10 回填: 词表外的历史词', now(), found.id);
      return { id: found.id, word: found.name, created: false, needsReview: true, hit: norm.hit };
    }
    return { id: found.id, word: found.name, created: false, needsReview: found.status !== 'ok', hit: norm.hit };
  }
  // 词表外的新词: 建元素 + 待审 (宁可不并)
  const parentName = parentNameOf(kind, norm.word);
  const parentId = parentName && parentName !== norm.word
    ? (findValue(db, { name: parentName, kind })?.id ?? null) : null;
  const ts = now();
  const info = db.prepare(`INSERT INTO value_nodes
    (name, aliases, kind, parent_id, gloss, source, status, note, is_active, created_at, updated_at)
    VALUES (?, '[]', ?, ?, ?, ?, 'needs_review', ?, 1, ?, ?)`)
    .run(norm.word, kind, parentId, gloss || (parentName ? `上位类: ${parentName}` : ''),
      source === 'seed' ? 'seed' : 'extracted', note, ts, ts);
  return { id: Number(info.lastInsertRowid), word: norm.word, created: true, needsReview: true, hit: false };
}

/** 把一条记录的指针接上 (文本缓存与 fk 一起写, 二者不得漂移) */
export function linkVocabulary(db, kind, rowId, raw, idCol = 'id', opts) {
  const ptr = POINTERS[kind]?.[0];
  if (!ptr) throw new Error(`未知词表域: ${kind}`);
  if (raw == null || raw === '') {
    db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = NULL WHERE ${idCol} = ?`).run(rowId);
    return null;
  }
  const el = ensureVocabulary(db, kind, raw, opts);
  if (!el) return null;
  if (ptr.text) {
    db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = ?, ${ptr.text} = ? WHERE ${idCol} = ?`)
      .run(el.id, el.word, rowId);
  } else {
    db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = ? WHERE ${idCol} = ?`).run(el.id, rowId);
  }
  return el;
}

/**
 * 改写一个"由词表支撑的值" —— **文本与指针必须同时写**。
 *
 * 单列更新是漂移的唯一来源: 对齐服务原先只 `SET status = 'realized'`, 指针留在旧元素上,
 * 于是"文本说兑现、指针说未决"。vocabulary.smoke 的零漂移断言就是钉这个的。
 */
export function setVocabValue(db, kind, { table, idColumn = 'id', rowId, value }) {
  const ptr = POINTERS[kind]?.[0];
  if (!ptr || ptr.table !== table) throw new Error(`词表域 ${kind} 与表 ${table} 不匹配`);
  if (value == null || value === '') {
    if (ptr.text) db.prepare(`UPDATE ${table} SET ${ptr.fk} = NULL, ${ptr.text} = NULL WHERE ${idColumn} = ?`).run(rowId);
    else db.prepare(`UPDATE ${table} SET ${ptr.fk} = NULL WHERE ${idColumn} = ?`).run(rowId);
    return null;
  }
  const el = ensureVocabulary(db, kind, value);
  if (ptr.text) {
    db.prepare(`UPDATE ${table} SET ${ptr.fk} = ?, ${ptr.text} = ? WHERE ${idColumn} = ?`)
      .run(el?.id ?? null, el ? el.word : value, rowId);
  } else {
    db.prepare(`UPDATE ${table} SET ${ptr.fk} = ? WHERE ${idColumn} = ?`).run(el?.id ?? null, rowId);
  }
  return el;
}

// ---------------- 旧数据回填 (只填空指针, 可重复执行) ----------------
/**
 * 把旧口径的自由文本机械归一后接上指针:
 *   agent→发起者 / appearance→外貌(→appearance) / 拦截盘查 挂上位类 / …
 * 只处理 fk 为 NULL 的行, 因此可重复执行; 旧文本列会被改写成**归一后的词** (缓存与指针同步)。
 */
export function backfillVocabulary(db) {
  const report = { filled: {}, created: [], skipped: 0 };
  for (const [kind, ptrs] of Object.entries(POINTERS)) {
    let filled = 0;
    for (const ptr of ptrs) {
      const srcCol = ptr.from ?? ptr.text;          // 归一化的来源列 (时段从 label 现推)
      const rows = db.prepare(`SELECT rowid AS rid, ${srcCol} AS raw FROM ${ptr.table}
        WHERE ${ptr.fk} IS NULL AND ${srcCol} IS NOT NULL AND ${srcCol} <> ''`).all();
      for (const r of rows) {
        const word = ptr.derive === 'period' ? parseTimeLabel(r.raw)?.period : r.raw;
        if (!word) { report.skipped++; continue; }
        const el = ensureVocabulary(db, kind, word, { source: 'extracted', note: 'backfill v10' });
        if (!el) { report.skipped++; continue; }
        if (ptr.text) {
          db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = ?, ${ptr.text} = ? WHERE rowid = ?`)
            .run(el.id, el.word, r.rid);
        } else {
          db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = ? WHERE rowid = ?`).run(el.id, r.rid);
        }
        filled++;
        if (el.created) report.created.push(`${kind}:${el.word}`);
      }
      // 空文本也要有指针: status/attitude 之类的缺省值
      if (ptr.text) db.prepare(`UPDATE ${ptr.table} SET ${ptr.fk} = NULL WHERE ${ptr.text} IS NULL`).run();
    }
    report.filled[kind] = filled;
  }
  // 旧库遗留的"别名节点" (如 aspect 的 外貌 与 appearance 并存) 没有指针了, 并掉
  report.merged = mergeAliasDuplicates(db);
  // 时间点的整句标签也顺手拆开 (label=时段头 / note=修饰语); 撞车则不拆
  report.splitTimeLabels = splitTimeLabels(db);
  return report;
}

/**
 * 把时间点的**整句标签**拆成 label(时段头) + note(修饰语) —— "暮色中，临近戌时三刻落闸"
 * 这类标签本来会被 20 条实例共享成一整句话挂在时间轴上。
 *
 * 三条安全线 (缺一条就可能把两个时刻并成一个, 那等于时间轴丢刻度):
 *   ① 只在没有修饰语时不动 (没得拆);
 *   ② 同一聊天里已有同名 label 的行 -> **不拆** (宁可标签长, 不可并掉一个时刻);
 *   ③ 原句完整进 note, 一个字不丢。
 */
export function splitTimeLabels(db) {
  const rows = db.prepare("SELECT id, chat_id, label, note FROM time_points WHERE note = ''").all();
  let split = 0;
  for (const r of rows) {
    const parsed = parseTimeLabel(r.label);
    if (!parsed?.qualifier || !parsed.head || parsed.head === parsed.full || parsed.suffix) continue;
    const clash = db.prepare('SELECT id FROM time_points WHERE chat_id = ? AND label = ?').get(r.chat_id, parsed.head);
    if (clash) continue;
    db.prepare('UPDATE time_points SET label = ?, note = ? WHERE id = ?').run(parsed.head, parsed.qualifier, r.id);
    split++;
  }
  return split;
}

/** 把 kind 内"名字其实是别人别名"的元素并进规范元素 (只并**没有任何指针**的那些) */
export function mergeAliasDuplicates(db) {
  const merged = [];
  for (const kind of VOCAB_KINDS) {
    const nodes = db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND is_active = 1').all(kind);
    for (const n of nodes) {
      const canon = ALIAS_INDEX.get(kind)?.get(key(n.name));
      if (!canon || canon === n.name) continue;
      const target = db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND name = ?').get(kind, canon);
      if (!target || target.id === n.id) continue;
      const ptrs = POINTERS[kind] ?? [];
      const used = ptrs.reduce((sum, p) =>
        sum + db.prepare(`SELECT count(*) c FROM ${p.table} WHERE ${p.fk} = ?`).get(n.id).c, 0);
      if (used > 0) continue;                       // 还有指针指它就别动 (先 merge 再清理)
      mergeVocabulary(db, kind, n.id, target.id, { silent: true });
      merged.push(`${kind}:${n.name}->${canon}`);
    }
  }
  return merged;
}

/**
 * 人工归并: 把 from 并进 to (改所有指针 + 别名并入 + 删掉源元素)。
 * ⚠️ 不可逆 —— 这正是"宁可不并, 待审队列等人工"的原因; CLI 才是它的入口。
 */
export function mergeVocabulary(db, kind, fromId, toId, { silent = false } = {}) {
  if (fromId === toId) return null;
  const from = db.prepare('SELECT * FROM value_nodes WHERE id = ? AND kind = ?').get(fromId, kind);
  const to = db.prepare('SELECT * FROM value_nodes WHERE id = ? AND kind = ?').get(toId, kind);
  if (!from || !to) throw new Error(`归并失败: 元素不存在或域不符 (${kind})`);
  const ts = now();
  const moved = {};
  for (const p of POINTERS[kind] ?? []) {
    // 指针-only 的域 (时段) 只挪指针, 绝不改写世界内时刻的名字
    const sets = p.text ? `${p.fk} = ?, ${p.text} = ?` : `${p.fk} = ?`;
    const args = p.text ? [to.id, to.name, from.id] : [to.id, from.id];
    const info = db.prepare(`UPDATE ${p.pkCollision ? 'OR IGNORE ' : ''}${p.table} SET ${sets} WHERE ${p.fk} = ?`)
      .run(...args);
    moved[p.table] = info.changes;
    if (p.pkCollision) db.prepare(`DELETE FROM ${p.table} WHERE ${p.fk} = ?`).run(from.id);  // 撞主键的重复行
  }
  const aliases = [...new Set([...parseAliases(to.aliases), from.name, ...parseAliases(from.aliases)])]
    .filter((a) => a && a !== to.name);
  db.prepare('UPDATE value_nodes SET aliases = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(aliases), ts, to.id);
  db.prepare('DELETE FROM value_nodes WHERE id = ?').run(from.id);   // 词表不留残影: 审计在别名里
  if (silent) return { from: from.name, to: to.name, moved };
  return { from: from.name, to: to.name, moved, aliases };
}

// ---------------- 审计 / 报表 ----------------
/**
 * 词表体检。三个数字最关键:
 *   reuse      平均复用度 (实例数 / 元素数) —— 1.0 意味着"每个实例自造一个词", 词表形同虚设
 *   needsReview 待审队列 (词表外的新词, 等着人工挂类或归并)
 *   drift      文本缓存与指针不一致的行 (必须为 0; 由 vocabulary.smoke 钉住)
 */
export function auditVocabulary(db, { kind = null } = {}) {
  const kinds = kind ? [kind] : VOCAB_KINDS;
  const out = { kinds: {}, needsReview: [], drift: [], orphan: [] };
  for (const k of kinds) {
    const nodes = db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND is_active = 1').all(k);
    const ptrs = POINTERS[k] ?? [];
    let rows = 0, linked = 0;
    const drift = [];
    for (const p of ptrs) {
      // 待分类的总体 = 有来源文本的行 (指针-only 的域用 from 列, 如 time_points.label)
      const srcCol = p.from ?? p.text;
      const total = db.prepare(`SELECT count(*) c FROM ${p.table} WHERE ${srcCol} IS NOT NULL AND ${srcCol} <> ''`).get().c;
      const withFk = db.prepare(`SELECT count(*) c FROM ${p.table} WHERE ${p.fk} IS NOT NULL`).get().c;
      rows += total; linked += withFk;
      // 漂移只对"有文本缓存"的域成立 —— 时段没有缓存 (label 是世界内时刻的名字, 不是规范词)
      if (p.text) {
        drift.push(...db.prepare(`SELECT '${p.table}' AS tbl, rowid AS rid, ${p.text} AS text, ${p.fk} AS fk
            FROM ${p.table}
           WHERE ${p.fk} IS NOT NULL
             AND ${p.text} IS NOT (SELECT name FROM value_nodes WHERE id = ${p.fk})`).all());
      }
    }
    const used = new Map();
    for (const p of ptrs) for (const r of db.prepare(`SELECT ${p.fk} AS id, count(*) c FROM ${p.table}
        WHERE ${p.fk} IS NOT NULL GROUP BY ${p.fk}`).all()) {
      used.set(r.id, (used.get(r.id) ?? 0) + r.c);
    }
    const reused = nodes.filter((n) => (used.get(n.id) ?? 0) > 1).length;
    out.kinds[k] = {
      nodes: nodes.length, rows, linked,
      reuse: Number((rows / Math.max(1, used.size)).toFixed(2)),
      reusedNodes: reused,
      pendingRows: rows - linked,
    };
    for (const n of nodes) if (n.status !== 'ok') out.needsReview.push({ kind: k, id: n.id, name: n.name, count: used.get(n.id) ?? 0 });
    // 孤儿 = **抽出来的词没人用** (待审队列的积压); 种子词表里暂时用不上的词不算问题 ——
    // 词表本来就是"给未来准备的词汇", 空着的规范词正是它的意义
    for (const n of nodes) if (!used.has(n.id) && n.source !== 'seed')
      out.orphan.push({ kind: k, id: n.id, name: n.name, status: n.status });
    out.drift.push(...drift.map((d) => ({ ...d, kind: k })));
  }
  out.needsReview.sort((a, b) => b.count - a.count);
  return out;
}

/** 某域的元素 + 复用度 (图/面板/CLI 共用) */
export function listVocabulary(db, { kind, chatId = null } = {}) {
  const kinds = kind ? [kind] : VOCAB_KINDS;
  const out = [];
  for (const k of kinds) {
    for (const n of db.prepare('SELECT * FROM value_nodes WHERE kind = ? AND is_active = 1 ORDER BY name').all(k)) {
      const ptrs = POINTERS[k] ?? [];
      let count = 0;
      for (const p of ptrs) {
        const cond = chatId && p.table === 'events' ? 'AND chat_id = @chatId' : '';
        count += db.prepare(`SELECT count(*) c FROM ${p.table} WHERE ${p.fk} = @id ${cond}`)
          .get({ id: n.id, chatId }).c;
      }
      const parent = n.parent_id ? db.prepare('SELECT name FROM value_nodes WHERE id = ?').get(n.parent_id)?.name : null;
      out.push({ ...n, aliases: parseAliases(n.aliases), count, parentName: parent });
    }
  }
  return out;
}
