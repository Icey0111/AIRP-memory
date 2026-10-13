// 一阶记忆: 写入 / 查询 / 更新 / 软删除
import { now, clamp01 } from '../utils/text.js';
import {
  MEMORY_TYPE_VALUES, MEMORY_SCOPE_VALUES, MEMORY_DEFAULTS,
} from '../domain/constants.js';

const TYPES = new Set(MEMORY_TYPE_VALUES);
const SCOPES = new Set(MEMORY_SCOPE_VALUES);

export function createMemory(db, input) {
  const {
    type, content, keywords = '', importance, emotionalWeight,
    scope = MEMORY_DEFAULTS.scope, characterId = null, chatId = null,
    sourceMessageIds = [], inWorldTime = null, tags = [],
  } = input;

  if (!TYPES.has(type)) throw new Error(`type 必须是 ${MEMORY_TYPE_VALUES.join('/')}, 收到: ${type}`);
  if (!content || !content.trim()) throw new Error('content 不能为空');
  if (!SCOPES.has(scope)) throw new Error(`scope 必须是 ${MEMORY_SCOPE_VALUES.join('/')}, 收到: ${scope}`);
  if (scope === 'character' && !characterId) throw new Error('scope=character 时 characterId 必填');

  const ts = now();
  const info = db.prepare(`
    INSERT INTO memories (type, content, keywords, importance, emotional_weight,
      scope, character_id, chat_id, source_message_ids, in_world_time,
      created_at, updated_at)
    VALUES (@type, @content, @keywords, @importance, @emotionalWeight,
      @scope, @characterId, @chatId, @sourceMessageIds, @inWorldTime,
      @ts, @ts)
  `).run({
    type, content: content.trim(), keywords,
    importance: clamp01(importance, MEMORY_DEFAULTS.importance),
    emotionalWeight: clamp01(emotionalWeight, MEMORY_DEFAULTS.emotionalWeight),
    scope, characterId, chatId,
    sourceMessageIds: JSON.stringify(sourceMessageIds),
    inWorldTime, ts,
  });

  const id = Number(info.lastInsertRowid);
  if (tags.length) setMemoryTags(db, id, tags);
  return getMemory(db, id);
}

export function getMemory(db, id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, tags: getTags(db, id) };
}

function getTags(db, id) {
  return db.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?').all(id).map((r) => r.tag);
}

export function setMemoryTags(db, id, tags) {
  const del = db.prepare('DELETE FROM memory_tags WHERE memory_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
  db.transaction(() => {
    del.run(id);
    for (const t of tags) if (t && String(t).trim()) ins.run(id, String(t).trim());
  })();
}

// 可见性口径: global 全部可见 + character 当前角色 + chat 当前聊天
const VISIBILITY = `(
  m.scope = 'global'
  OR (m.scope = 'character' AND m.character_id = @characterId)
  OR (m.scope = 'chat' AND m.chat_id = @chatId)
)`;

export function listMemories(db, { chatId = null, characterId = null, scope = null, type = null, includeInactive = false, limit = 50, offset = 0 } = {}) {
  const conds = [VISIBILITY];
  const params = { characterId, chatId, limit, offset };
  if (scope) { conds.push('m.scope = @scope'); params.scope = scope; }
  if (type) { conds.push('m.type = @type'); params.type = type; }
  if (!includeInactive) conds.push('m.is_active = 1');

  return db.prepare(`
    SELECT m.* FROM memories m
    WHERE ${conds.join(' AND ')}
    ORDER BY m.importance DESC, m.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

export function updateMemory(db, id, patch) {
  const existing = getMemory(db, id);
  if (!existing) return null;

  const fields = [];
  const params = { id, ts: now() };
  if (patch.content !== undefined) { fields.push('content = @content'); params.content = String(patch.content); }
  if (patch.keywords !== undefined) { fields.push('keywords = @keywords'); params.keywords = String(patch.keywords); }
  if (patch.importance !== undefined) { fields.push('importance = @importance'); params.importance = clamp01(patch.importance); }
  if (patch.emotionalWeight !== undefined) { fields.push('emotional_weight = @emotionalWeight'); params.emotionalWeight = clamp01(patch.emotionalWeight, MEMORY_DEFAULTS.emotionalWeight); }
  if (patch.inWorldTime !== undefined) { fields.push('in_world_time = @inWorldTime'); params.inWorldTime = patch.inWorldTime; }
  if (patch.isActive !== undefined) { fields.push('is_active = @isActive'); params.isActive = patch.isActive ? 1 : 0; }

  if (fields.length) {
    db.prepare(`UPDATE memories SET ${fields.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  }
  if (patch.tags !== undefined) setMemoryTags(db, id, patch.tags);
  return getMemory(db, id);
}

// 软删除: 遗忘不物理删
export function deactivateMemory(db, id) {
  const info = db.prepare('UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), id);
  return info.changes > 0;
}
