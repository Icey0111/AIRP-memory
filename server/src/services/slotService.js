// 槽位与迁移 (V7-B, docs/verb-layer.md §16)
//
// 核心: **迁移记录是视图, 不是表** —— 它从既有的 supersedes 链无损推导:
//   链头 = 当前指针值; 沿指针回溯的相邻两行, 值不同 => 一次迁移, 值相同 => 一次确认。
//
// 于是"状态迁移不是新文本"这条主张在存储上兑现了: 值没变不写新行 (只 confirms+1),
// 值变了才写一行短记录。长文本只在**建立**槽位时写一次。
//
// 槽位定义 (SLOT_MODEL.slotDefs):
//   立场槽 = (holder, target, dimension); 值 = stance_type
//   属性槽 = (entity, aspect)             ; 值 = 观察内容 (迁移判定待 V8: 需要相似度才能
//                                           区分"重述"与"更新", 现在链只能当折叠计数用)
import { SLOT_MODEL } from '../domain/constants.js';

const OP = Object.fromEntries(SLOT_MODEL.operations.map((o) => [o.value, o.label]));

/** 立场槽的键 (跨端一致: (持有者, 对象, 维度)) */
export function stanceSlotKey(s) {
  return `${s.holder_type}:${s.holder_id}>${s.target_type}:${s.target_id}@${s.stance_dimension}`;
}

/**
 * 立场的槽位清单: 每个槽位的当前指针值 + 迁移序列 + 确认次数。
 *
 * 处理"历史遗留并存": V6 及以前不同 stance_type 可以并存 (老规则),
 * 所以同一槽位可能出现多条当前生效行 —— 取 id 最大者为指针, 其余标注为 legacyCoexist
 * (只标注、不改数据: 它们仍是可恢复的历史)。
 */
export function stanceSlots(db, { chatId = null } = {}) {
  const conds = ['s.is_active = 1', 's.valid_to_event_id IS NULL'];
  const params = {};
  if (chatId) { conds.push('s.chat_id = @chatId'); params.chatId = chatId; }
  const all = db.prepare(`
    SELECT s.* FROM stances s WHERE ${conds.join(' AND ')} ORDER BY s.id
  `).all(params);

  // ⚠️ 被覆盖集合必须从**全表**算, 不能只从生效行算:
  // 否则撤销(软删)一行的迁移后, 它的前驱会因为"没人 supersede 它"而复活成当前值 ——
  // 实测踩到。撤销的语义是不做自动回退 (要回退就恢复新行, 或重新写一个值),
  // 所以前驱仍算被覆盖, 该槽位就是"没有当前值"。
  const superseded = new Set(
    db.prepare('SELECT supersedes_stance_id AS id FROM stances WHERE supersedes_stance_id IS NOT NULL')
      .all().map((r) => r.id),
  );
  const byId = new Map(all.map((s) => [s.id, s]));
  const heads = all.filter((s) => !superseded.has(s.id));

  const groups = new Map();
  for (const h of heads) {
    const key = stanceSlotKey(h);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }

  const slots = [];
  for (const [key, headRows] of groups) {
    headRows.sort((a, b) => b.id - a.id);
    const current = headRows[0];
    const legacy = headRows.slice(1);
    slots.push({
      key,
      kind: 'stance',
      holderType: current.holder_type, holderId: current.holder_id,
      targetType: current.target_type, targetId: current.target_id,
      dimension: current.stance_dimension,
      stanceId: current.id,
      value: current.stance_type,
      intensity: current.intensity,
      confirms: current.confirms,
      /** 迁移序列 (含建立), 按时间正序 */
      transitions: buildTransitions(db, current.id, byId),
      /** V6 及以前遗留的同槽位并存行 (只标注) */
      legacyCoexist: legacy.map((l) => ({ id: l.id, value: l.stance_type })),
    });
  }
  return slots.sort((a, b) => a.key.localeCompare(b.key));
}

/** 沿 supersedes 指针回溯, 输出由旧到新的操作序列 */
function buildTransitions(db, headId, byId) {
  const chain = [];
  let cur = byId.get(headId) ?? db.prepare('SELECT * FROM stances WHERE id = ?').get(headId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    if (!cur.supersedes_stance_id) break;
    cur = byId.get(cur.supersedes_stance_id)
      ?? db.prepare('SELECT * FROM stances WHERE id = ?').get(cur.supersedes_stance_id);
  }
  chain.reverse();                                   // 旧 -> 新

  const out = [];
  let prev = null;
  for (const row of chain) {
    if (!prev) {
      out.push({ operation: 'create', value: row.stance_type, at: row.created_at, stanceId: row.id });
    } else if (prev.stance_type === row.stance_type) {
      // 旧数据可能留下同值相邻行 (V7 之前会写新行); V7 起同值不写行, 只累加 confirms
      out.push({ operation: 'confirm', value: row.stance_type, at: row.created_at, stanceId: row.id });
    } else {
      out.push({
        operation: 'migrate', from: prev.stance_type, value: row.stance_type,
        at: row.created_at, stanceId: row.id,
      });
    }
    // 该行自身的确认计数 (值没变时被再次观察到的次数), 紧跟其建立/迁移之后
    if (row.confirms > 0) {
      out.push({
        operation: 'confirm', value: row.stance_type, at: row.updated_at,
        stanceId: row.id, count: row.confirms,
      });
    }
    prev = row;
  }
  return out;
}

/** 全聊天的迁移序列 (只看值真的变过的那些), 按时间正序 */
export function stanceTransitions(db, { chatId = null, limit = 50 } = {}) {
  const out = [];
  for (const slot of stanceSlots(db, { chatId })) {
    for (const t of slot.transitions) {
      if (t.operation !== 'migrate') continue;
      out.push({ ...t, slotKey: slot.key, holderType: slot.holderType, targetType: slot.targetType });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-limit);
}

/** 汇总 (面板与统计用) */
export function slotSummary(db, { chatId = null } = {}) {
  const slots = stanceSlots(db, { chatId });
  const transitions = stanceTransitions(db, { chatId });
  const counts = { create: 0, migrate: 0, confirm: 0, revoke: 0 };
  for (const s of slots) for (const t of s.transitions) counts[t.operation] = (counts[t.operation] ?? 0) + 1;
  return {
    slots,
    transitions,
    counts,
    /** 标签取自 constants (跨端同源) */
    labels: OP,
    slotDefs: SLOT_MODEL.slotDefs,
    defaultDimension: SLOT_MODEL.stanceDefaultDimension,
  };
}
