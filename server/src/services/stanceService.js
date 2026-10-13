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

// 实体名解析: 多态实体 id -> 名字
// (立场两端是 people / orgs; 观察块的锚点还可能是 locations / items, 因此这里覆盖四种)
// 注入时一律渲染成名字 —— LLM 读不懂裸整数 id, 名字才能和其他段落互相呼应
const NAME_TABLES = { person: 'people', location: 'locations', item: 'items', org: 'orgs' };

export function resolveEntityName(db, entityType, entityId) {
  const table = NAME_TABLES[entityType];
  if (!table) return null;
  return db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(entityId)?.name ?? null;
}

// 批量解析: [{type, id}] -> Map<"type:id", name>。
// 列表场景 (chatStances / stanceOverview) 必须走这里 —— 逐行调 resolveEntityName
// 是 N+1 (每行两次 prepare+get); 批量版每种实体类型只查一次。
export function resolveEntityNames(db, pairs) {
  const byType = new Map();
  for (const p of pairs) {
    if (!NAME_TABLES[p.type] || p.id == null) continue;
    if (!byType.has(p.type)) byType.set(p.type, new Set());
    byType.get(p.type).add(p.id);
  }
  const out = new Map();
  for (const [type, ids] of byType) {
    const arr = [...ids];
    const ph = arr.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id, name FROM ${NAME_TABLES[type]} WHERE id IN (${ph})`).all(...arr);
    for (const r of rows) out.set(`${type}:${r.id}`, r.name);
  }
  return out;
}

// 关系速览: 某实体的所有当前生效立场, 带上对端名称 (画像/注入用)
export function stanceOverview(db, { holderType, holderId, chatId = null }) {
  const rows = currentStances(db, { holderType, holderId, chatId });
  const names = resolveEntityNames(db, rows.flatMap((s) => [
    { type: s.holder_type, id: s.holder_id },
    { type: s.target_type, id: s.target_id },
  ]));
  return rows.map((s) => ({
    ...s,
    holder_name: names.get(`${s.holder_type}:${s.holder_id}`) ?? null,
    target_name: names.get(`${s.target_type}:${s.target_id}`) ?? null,
  }));
}

/**
 * 当前聊天的全部生效立场 (注入用), 双端名字都解析成人名/组织名。
 * 排序: importance 降序取前 limit 条 (规模防线), 再按持方归拢 ——
 * 归拢是为了让同持方的相邻行落到同一组, 渲染时"持方"列只出现一次。
 * 持方之间的先后 = 该持方最高 importance 降序 (关系越重越靠前), 不是按名字码点乱排。
 */
export function chatStances(db, { chatId = null, limit = 0 } = {}) {
  const raw = currentStances(db, { chatId });
  const names = resolveEntityNames(db, raw.flatMap((s) => [
    { type: s.holder_type, id: s.holder_id },
    { type: s.target_type, id: s.target_id },
  ]));
  const rows = raw.map((s) => ({
    ...s,
    holder_name: names.get(`${s.holder_type}:${s.holder_id}`) ?? null,
    target_name: names.get(`${s.target_type}:${s.target_id}`) ?? null,
  }));
  const capped = limit > 0 ? rows.slice(0, limit) : rows;
  const holderRank = new Map();
  for (const s of capped) {
    const key = s.holder_name ?? `#${s.holder_id}`;
    holderRank.set(key, Math.max(holderRank.get(key) ?? 0, s.importance));
  }
  return capped.sort((a, b) => {
    const ka = a.holder_name ?? `#${a.holder_id}`;
    const kb = b.holder_name ?? `#${b.holder_id}`;
    if (ka !== kb) {
      const d = (holderRank.get(kb) ?? 0) - (holderRank.get(ka) ?? 0);
      if (d !== 0) return d;
      return ka < kb ? -1 : 1;
    }
    return b.importance - a.importance;
  });
}
