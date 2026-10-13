// V4 相对立场: 写入 / 当前生效口径 / 覆盖演化
// 概念: 关系 = 可演化的立场状态, 有向不对称 (holder -> target, 多态 person/org)
// 生效口径与观察块一致: is_active + 未过生效区间 + 未被新版立场覆盖
import { now, clamp01 } from '../utils/text.js';
import { STANCE_DEFAULTS } from '../domain/constants.js';

// 当前生效过滤 (SQL 片段)
const CURRENT = `
  s.is_active = 1
  AND s.valid_to_event_id IS NULL
  AND s.id NOT IN (SELECT supersedes_stance_id FROM stances WHERE supersedes_stance_id IS NOT NULL)
`;

export function addStance(db, {
  holderType, holderId, targetType, targetId,
  stanceType, intensity = STANCE_DEFAULTS.intensity,
  displayedType = null, isPublic = STANCE_DEFAULTS.isPublic, targetAware = STANCE_DEFAULTS.targetAware, basis = '',
  validFromEventId = null, validToEventId = null, supersedesStanceId = null,
  chatId, memoryId = null, sourceMessageIds = [], importance = STANCE_DEFAULTS.importance,
}) {
  if (!holderType || !holderId || !targetType || !targetId) {
    throw new Error('holder/target (type+id) 必填');
  }
  if (holderType === targetType && holderId === targetId) {
    throw new Error('holder 与 target 不能是同一实体');
  }
  if (!stanceType) throw new Error('stanceType 必填');
  if (!chatId) throw new Error('chatId 必填');
  const ts = now();
  const info = db.prepare(`
    INSERT INTO stances
      (holder_type, holder_id, target_type, target_id,
       stance_type, intensity, displayed_type, is_public, target_aware, basis,
       valid_from_event_id, valid_to_event_id, supersedes_stance_id,
       chat_id, memory_id, source_message_ids, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    holderType, holderId, targetType, targetId,
    stanceType, clamp01(intensity),
    displayedType, isPublic ? 1 : 0, targetAware ? 1 : 0, basis,
    validFromEventId, validToEventId, supersedesStanceId,
    chatId, memoryId, JSON.stringify(sourceMessageIds), clamp01(importance), ts, ts,
  );
  return Number(info.lastInsertRowid);
}

// 当前生效立场 (可按 holder/target/chat 过滤)
export function currentStances(db, {
  holderType = null, holderId = null,
  targetType = null, targetId = null, chatId = null,
} = {}) {
  const conds = [CURRENT];
  const params = {};
  if (holderType) { conds.push('s.holder_type = @holderType'); params.holderType = holderType; }
  if (holderId) { conds.push('s.holder_id = @holderId'); params.holderId = holderId; }
  if (targetType) { conds.push('s.target_type = @targetType'); params.targetType = targetType; }
  if (targetId) { conds.push('s.target_id = @targetId'); params.targetId = targetId; }
  if (chatId) { conds.push('s.chat_id = @chatId'); params.chatId = chatId; }
  return db.prepare(`
    SELECT s.* FROM stances s
    WHERE ${conds.join(' AND ')}
    ORDER BY s.importance DESC, s.id DESC
  `).all(params);
}

// 找某一对关系上某类型的当前生效立场 (演化判定的锚点)
export function findCurrentStance(db, { holderType, holderId, targetType, targetId, stanceType, chatId }) {
  const rows = currentStances(db, { holderType, holderId, targetType, targetId, chatId });
  return rows.find((s) => s.stance_type === stanceType) ?? null;
}

// 全量列表 (含被覆盖的历史立场, 追溯"关系以前什么样")
export function listStances(db, { holderType, holderId, includeHistory = false, chatId = null }) {
  if (includeHistory) {
    const conds = ['s.holder_type = @holderType', 's.holder_id = @holderId'];
    const params = { holderType, holderId };
    if (chatId) { conds.push('s.chat_id = @chatId'); params.chatId = chatId; }
    return db.prepare(`
      SELECT s.* FROM stances s WHERE ${conds.join(' AND ')} ORDER BY s.id
    `).all(params);
  }
  return currentStances(db, { holderType, holderId, chatId });
}

export function softDeleteStance(db, id) {
  const info = db.prepare(
    'UPDATE stances SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1'
  ).run(now(), id);
  return info.changes > 0;
}

// 关系速览: 某实体的所有当前生效立场, 带上对端名称 (画像/注入用)
export function stanceOverview(db, { holderType, holderId, chatId = null }) {
  const rows = currentStances(db, { holderType, holderId, chatId });
  return rows.map((s) => ({
    ...s,
    target_name: s.target_type === 'person'
      ? db.prepare('SELECT name FROM people WHERE id = ?').get(s.target_id)?.name
      : db.prepare('SELECT name FROM orgs WHERE id = ?').get(s.target_id)?.name,
  }));
}
