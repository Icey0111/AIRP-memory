// V4 相对立场 / V7 槽位模型: 写入 / 当前生效口径 / 覆盖演化
// 概念: 关系 = 可演化的立场状态, 有向不对称 (holder -> target, 多态 person/org)
// 生效口径与观察块一致: is_active + 未过生效区间 + 未被新版立场覆盖
//
// V7 槽位规则 (docs/verb-layer.md §16, 指针语义):
//   槽位 = (holder, target, dimension)。同槽位上的写入按三种结构操作处理:
//     建立 create   槽位原本为空 -> 写一行 (唯一写文本处)
//     确认 confirm  值没变, 只是再次被观察到 -> **更新同一行** + confirms+1 (不新增行)
//     迁移 migrate  值变了 -> 写一行并让它的 supersedes 指向槽位当前行 (指针移动)
//   于是"戒备 → 信任"不再堆两行文本, 而是同一槽位上的一次指针移动;
//   强度变化属于同一值的幅度微调, 只更新行, 不产生迁移。
import { now, clamp01 } from '../utils/text.js';
import { STANCE_DEFAULTS, SLOT_MODEL, INJECTION_TABLES } from '../domain/constants.js';
import { findOrCreateValue } from './valueService.js';

// 当前生效过滤 (SQL 片段)
const CURRENT = `
  s.is_active = 1
  AND s.valid_to_event_id IS NULL
  AND s.id NOT IN (SELECT supersedes_stance_id FROM stances WHERE supersedes_stance_id IS NOT NULL)
`;

/** 槽位当前生效行: 同 (holder, target, dimension) 里 id 最大的一条 */
export function currentSlotStance(db, {
  holderType, holderId, targetType, targetId,
  dimension = SLOT_MODEL.stanceDefaultDimension, chatId = null,
}) {
  const params = { holderType, holderId, targetType, targetId, dimension };
  let sql = `
    SELECT s.* FROM stances s
    WHERE ${CURRENT}
      AND s.holder_type = @holderType AND s.holder_id = @holderId
      AND s.target_type = @targetType AND s.target_id = @targetId
      AND s.stance_dimension = @dimension
  `;
  if (chatId) { sql += ' AND s.chat_id = @chatId'; params.chatId = chatId; }
  sql += ' ORDER BY s.id DESC LIMIT 1';
  return db.prepare(sql).get(params) ?? null;
}

/**
 * 立场的槽位写入 (V7 核心)。
 * @returns {{id:number, operation:'create'|'confirm'|'migrate', from:number|null,
 *            fromValue:string|null, value:string, valueCreated:boolean}}
 */
export function applyStance(db, {
  holderType, holderId, targetType, targetId,
  stanceType, intensity = STANCE_DEFAULTS.intensity,
  displayedType = null, isPublic = STANCE_DEFAULTS.isPublic, targetAware = STANCE_DEFAULTS.targetAware, basis = '',
  dimension = SLOT_MODEL.stanceDefaultDimension,
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

  // 取值元素: 元素先于指针 —— 值本身也是网络里的节点 (§16.4)
  const value = findOrCreateValue(db, { name: stanceType, kind: 'stance_type' });

  const ts = now();
  const slot = currentSlotStance(db, {
    holderType, holderId, targetType, targetId, dimension, chatId,
  });

  // 确认: 槽位当前值与新值相同 -> 不新增行, 只更新幅度并累加确认计数
  if (slot && slot.stance_type === stanceType) {
    db.prepare(`
      UPDATE stances
      SET intensity = ?, displayed_type = ?, is_public = ?, target_aware = ?, basis = ?,
          importance = ?, confirms = confirms + 1, updated_at = ?
      WHERE id = ?
    `).run(
      clamp01(intensity), displayedType ?? slot.displayed_type,
      isPublic ? 1 : 0, targetAware ? 1 : 0, basis || slot.basis,
      clamp01(importance), ts, slot.id,
    );
    return {
      id: slot.id, operation: 'confirm', from: slot.id,
      fromValue: slot.stance_type, value: stanceType, valueCreated: value.created,
    };
  }

  // 迁移 (槽位有值且不同) 或 建立 (槽位为空)
  const predecessor = slot?.id ?? (supersedesStanceId ?? null);
  const info = db.prepare(`
    INSERT INTO stances
      (holder_type, holder_id, target_type, target_id,
       stance_type, intensity, displayed_type, is_public, target_aware, basis,
       valid_from_event_id, valid_to_event_id, supersedes_stance_id,
       chat_id, memory_id, source_message_ids, importance, stance_dimension,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    holderType, holderId, targetType, targetId,
    stanceType, clamp01(intensity),
    displayedType, isPublic ? 1 : 0, targetAware ? 1 : 0, basis,
    validFromEventId, validToEventId, predecessor,
    chatId, memoryId, JSON.stringify(sourceMessageIds), clamp01(importance), dimension,
    ts, ts,
  );
  return {
    id: Number(info.lastInsertRowid),
    operation: slot ? 'migrate' : 'create',
    from: predecessor,
    fromValue: slot?.stance_type ?? null,
    value: stanceType,
    valueCreated: value.created,
  };
}

/** 兼容旧签名: 只返回 id (既有调用方与测试沿用) */
export function addStance(db, input) {
  return applyStance(db, input).id;
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
// V7 起: 槽位口径 —— 不按 stance_type 过滤 (同槽位的值变化就是迁移)。
export function findCurrentStance(db, { holderType, holderId, targetType, targetId, chatId, dimension }) {
  return currentSlotStance(db, { holderType, holderId, targetType, targetId, chatId, dimension });
}

/**
 * 演化链 (V7): 沿 supersedes 回溯, 取**不同的值**串起来, 如 `戒备 → 信任`。
 * 重复的值折叠掉 (确认不产生新节点); 链头就是当前值。
 * 取不到历史 (或历史值全相同) 时返回 null —— 调用方据 null 决定不显示。
 */
export function evolutionOf(db, stanceId, maxValues = INJECTION_TABLES.stanceDisplay.evolutionMaxValues) {
  const values = [];
  let cur = db.prepare('SELECT id, stance_type, supersedes_stance_id FROM stances WHERE id = ?').get(stanceId);
  const seen = new Set();
  while (cur && seen.size < maxValues + 4) {
    if (seen.has(cur.id)) break;            // 防环
    seen.add(cur.id);
    if (values[values.length - 1] !== cur.stance_type) values.push(cur.stance_type);
    if (!cur.supersedes_stance_id) break;
    cur = db.prepare('SELECT id, stance_type, supersedes_stance_id FROM stances WHERE id = ?')
      .get(cur.supersedes_stance_id);
  }
  if (values.length <= 1) return null;      // 没变过 -> 不显示演化
  return values.reverse().slice(-maxValues).join(INJECTION_TABLES.stanceDisplay.evolutionSep);
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
    // 演化链: 值变过才有 (值没变只累加 confirms), 由渲染层决定怎么显示
    evolution: INJECTION_TABLES.stanceDisplay.showEvolution ? evolutionOf(db, s.id) : null,
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
