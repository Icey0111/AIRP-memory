// 二阶实体: find-or-create (别名归并) / 时间线 / 事件与因果边
import { now, clamp01 } from '../utils/text.js';
import { VERB_LAYER } from '../domain/constants.js';

// ---------- 别名匹配: 主称呼相等 或 别名数组中包含 ----------
function findPersonByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM people
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(people.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

function mergeAliasList(existing, newAliases) {
  const cur = JSON.parse(existing.aliases || '[]');
  const merged = [...new Set([...cur, ...newAliases.filter((a) => a && a !== existing.name)])];
  return JSON.stringify(merged);
}

/**
 * find-or-create 人物 (别名归并)。
 *
 * ⚠️ `mergeAliases = false` 是 V6 的数据安全底线用法: **只有叙述者断言才能触发实体归并**
 *    (docs/verb-layer.md §5.3)。人物层说"那人是艾拉"若被当作归并处理, 会**不可逆地
 *    把两个实体并成一个** —— 这正是"撒谎/认错人"这类剧情的常见来源。
 *    故归属命题 (source_type='attributed') 解析人物时一律传 false: 只查不并, 找不到就新建,
 *    绝不把新别名挂到既有实体上。
 */
export function findOrCreatePerson(db, { name, aliases = [], personType = 'npc', mergeAliases = true }) {
  if (!name || !name.trim()) throw new Error('人名不能为空');
  name = name.trim();
  const existing = findPersonByNameOrAlias(db, name);
  if (existing) {
    if (!mergeAliases) return { ...existing, existed: true };
    // 归并新别名
    const merged = mergeAliasList(existing, aliases);
    if (merged !== existing.aliases) {
      db.prepare('UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?').run(merged, now(), existing.id);
    }
    return { ...existing, aliases: merged, existed: true };
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO people (name, aliases, person_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(aliases.filter((a) => a && a !== name)), personType, ts, ts);
  return { id: Number(info.lastInsertRowid), name, aliases: JSON.stringify(aliases), person_type: personType, existed: false };
}

function findLocationByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM locations
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(locations.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

export function findOrCreateLocation(db, { name, parentName = null }) {
  if (!name || !name.trim()) return null;
  name = name.trim();
  const existing = findLocationByNameOrAlias(db, name);
  if (existing) return { ...existing, existed: true };

  let parentId = null;
  if (parentName) {
    const parent = findOrCreateLocation(db, { name: parentName });
    parentId = parent.id;
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO locations (name, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(name, parentId, ts, ts);
  return { id: Number(info.lastInsertRowid), name, parent_id: parentId, existed: false };
}

// ---------- 组织: 与人物同构的别名归并 ----------
function findOrgByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM orgs
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(orgs.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

export function findOrCreateOrg(db, { name, aliases = [], description = '' }) {
  if (!name || !name.trim()) throw new Error('组织名不能为空');
  name = name.trim();
  const existing = findOrgByNameOrAlias(db, name);
  if (existing) {
    const merged = mergeAliasList(existing, aliases);
    if (merged !== existing.aliases) {
      db.prepare('UPDATE orgs SET aliases = ?, updated_at = ? WHERE id = ?').run(merged, now(), existing.id);
    }
    return { ...existing, aliases: merged, existed: true };
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO orgs (name, aliases, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(aliases.filter((a) => a && a !== name)), description, ts, ts);
  return { id: Number(info.lastInsertRowid), name, aliases: JSON.stringify(aliases), existed: false };
}

// ---------- 时间线: 按聊天隔离, seq 缺省顺延 ----------
export function findOrCreateTimePoint(db, { chatId, label, seq = null }) {
  if (!label || !label.trim()) return null;
  label = label.trim();
  const existing = db.prepare(
    'SELECT * FROM time_points WHERE chat_id = ? AND label = ?'
  ).get(chatId, label);
  if (existing) return { ...existing, existed: true };

  if (seq == null) {
    seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM time_points WHERE chat_id = ?').get(chatId).m) + 1;
  }
  const info = db.prepare(`
    INSERT INTO time_points (chat_id, label, seq, created_at) VALUES (?, ?, ?, ?)
  `).run(chatId, label, seq, now());
  return { id: Number(info.lastInsertRowid), chat_id: chatId, label, seq, existed: false };
}

// ---------- 事件 ----------
export function findEventByTitle(db, chatId, title) {
  return db.prepare(
    'SELECT * FROM events WHERE chat_id = ? AND title = ? AND is_active = 1'
  ).get(chatId, title);
}

export function createEvent(db, {
  title, process = '', causeText = '', resultText = '',
  timeId = null, locationId = null, chatId, memoryId = null,
  sourceMessageIds = [], importance = 0.5, emotionalWeight = 0,
  // ---- V6: 动词槽与命题三轴 ----
  verbType = '', verbSurface = '',
  polarity = VERB_LAYER.defaults.polarity,
  sourceType = VERB_LAYER.defaults.sourceType,
  sourcePersonId = null,
  attitude = null,
  tense = VERB_LAYER.defaults.tense,
  status = VERB_LAYER.defaults.status,
  alignedInstanceId = null,
  parentInstanceId = null,
  parentRole = null,
}) {
  const ts = now();
  const info = db.prepare(`
    INSERT INTO events (title, process, cause_text, result_text,
      time_id, location_id, chat_id, memory_id, source_message_ids,
      importance, emotional_weight,
      verb_type, verb_surface, polarity, source_type, source_person_id, attitude,
      tense, status, aligned_instance_id, parent_instance_id, parent_role,
      created_at, updated_at)
    VALUES (@title, @process, @causeText, @resultText,
      @timeId, @locationId, @chatId, @memoryId, @sourceMessageIds,
      @importance, @emotionalWeight,
      @verbType, @verbSurface, @polarity, @sourceType, @sourcePersonId, @attitude,
      @tense, @status, @alignedInstanceId, @parentInstanceId, @parentRole,
      @ts, @ts)
  `).run({
    title, process, causeText, resultText,
    timeId, locationId, chatId, memoryId,
    sourceMessageIds: JSON.stringify(sourceMessageIds),
    importance: clamp01(importance), emotionalWeight: clamp01(emotionalWeight, 0),
    verbType, verbSurface, polarity, sourceType, sourcePersonId, attitude,
    tense, status, alignedInstanceId, parentInstanceId, parentRole,
    ts,
  });
  return Number(info.lastInsertRowid);
}

export function addEventParticipant(db, { eventId, personId, role = '参与者' }) {
  db.prepare(`
    INSERT OR IGNORE INTO event_participants (event_id, person_id, role) VALUES (?, ?, ?)
  `).run(eventId, personId, role);
}

export function addEventLink(db, { fromId, toId, relation = 'caused' }) {
  if (fromId === toId) return false;
  const info = db.prepare(`
    INSERT OR IGNORE INTO event_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)
  `).run(fromId, toId, relation, now());
  return info.changes > 0;
}

export function addEntityRef(db, { memoryId, entityType, entityId }) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_entity_refs (memory_id, entity_type, entity_id) VALUES (?, ?, ?)
  `).run(memoryId, entityType, entityId);
}
