// 取值元素层 (V7-A, docs/verb-layer.md §16.4)
//
// **元素先于指针**（用户提出的前提）: 指针只能指向网中已存在的元素。
//   A→B 的合法性前提是 B 已经是网络里的元素。
//   若取值只是自由字符串, "信任 / 信赖 / 信服"就是三个不同文本 ——
//   指向不同文本 = 没指向同一个元素, 指针语义当场失效。
//
// 于是取值与实体走**完全相同**的机制: find-or-create + 别名归并。
// 结果: "信任"与"艾拉"在网络里是同类东西 (都是节点), 只有类型不同 —— 底层同构。
//
// 零新概念: 复用 people/locations 的既有写法 (name + aliases JSON + parent_id)。
//
// 归并策略: **宁可不并**。多一个节点不破坏指针语义 (指针仍指向一个确定元素);
//   错并却会抹掉刻意的细微区分 ("戒备" vs "警惕"), 且与实体归并一样不可逆。
import { now } from '../utils/text.js';

/** 按主称呼或别名在**同一 kind 域内**查找 (跨域同名视为不同元素) */
function findByNameOrAlias(db, name, kind) {
  return db.prepare(`
    SELECT * FROM value_nodes
    WHERE is_active = 1 AND kind = @kind
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(value_nodes.aliases) je WHERE je.value = @name
      ))
  `).get({ name, kind });
}

function parseAliases(raw) {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * find-or-create 取值元素。
 *
 * @param {object} db
 * @param {{name:string, aliases?:string[], kind?:string, parentName?:string|null,
 *          mergeAliases?:boolean}} input
 * @returns {{id:number, name:string, aliases:string, kind:string, parent_id:number|null,
 *            existed:boolean, created:boolean}}
 *   `created=true` 表示"这个词第一次出现在网络里" —— 即结构操作中的**建立**。
 *   迁移 (A→B) 的前提是 B 已存在; 调用方据此区分"建立"与"迁移"(见 slotService)。
 */
export function findOrCreateValue(db, { name, aliases = [], kind = '', parentName = null, mergeAliases = true }) {
  if (!name || !String(name).trim()) throw new Error('取值名不能为空');
  const valueName = String(name).trim();
  const valueKind = String(kind ?? '').trim();

  const existing = findByNameOrAlias(db, valueName, valueKind);
  if (existing) {
    if (!mergeAliases) return { ...existing, existed: true, created: false };
    const cur = parseAliases(existing.aliases);
    const merged = [...new Set([...cur, ...aliases.filter((a) => a && a !== existing.name)])];
    const next = JSON.stringify(merged);
    if (next !== existing.aliases) {
      db.prepare('UPDATE value_nodes SET aliases = ?, updated_at = ? WHERE id = ?')
        .run(next, now(), existing.id);
    }
    return { ...existing, aliases: next, existed: true, created: false };
  }

  let parentId = null;
  if (parentName) {
    const parent = findOrCreateValue(db, { name: parentName, kind: valueKind });
    parentId = parent.id;
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO value_nodes (name, aliases, kind, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(valueName, JSON.stringify(aliases.filter((a) => a && a !== valueName)), valueKind, parentId, ts, ts);

  return {
    id: Number(info.lastInsertRowid),
    name: valueName,
    aliases: JSON.stringify(aliases),
    kind: valueKind,
    parent_id: parentId,
    existed: false,
    created: true,
  };
}

/**
 * 只查不建。用于**迁移判定**: 目标元素已在网中 => 迁移; 否则 => 建立。
 * (归并路径: 先 findOrCreateValue 把别名并进来, 再迁移 —— 这也算"已存在"。)
 */
export function findValue(db, { name, kind = '' }) {
  if (!name) return null;
  return findByNameOrAlias(db, String(name).trim(), String(kind ?? '').trim()) ?? null;
}

/** 某取值域下的全部取值元素 (面板/注入的取值域展示用) */
export function listValues(db, { kind = null, includeInactive = false } = {}) {
  const conds = [];
  const params = {};
  if (kind) { conds.push('kind = @kind'); params.kind = kind; }
  if (!includeInactive) conds.push('is_active = 1');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM value_nodes ${where} ORDER BY kind, name
  `).all(params).map((r) => ({ ...r, aliases: parseAliases(r.aliases) }));
}
