// 槽位与迁移 (V7-B 立场 / V8 属性, docs/verb-layer.md §16)
//
// 核心: **迁移记录是视图, 不是表** —— 它从既有的 supersedes 链无损推导:
//   链头 = 当前指针值; 沿指针回溯的相邻两行, 值不同 => 一次迁移, 值相同 => 一次确认。
//
// 于是"状态迁移不是新文本"这条主张在存储上兑现了: 值没变不写新行 (只 confirms+1),
// 值变了才写一行短记录。长文本只在**建立**槽位时写一次。
//
// 槽位定义 (SLOT_MODEL.slotDefs):
//   立场槽 = (holder, target, dimension); 值 = stance_type
//   属性槽 = (entity, aspect)             ; 值 = 观察内容 —— V8 起也走同一套:
//                                           规范化文本判等 => 重述 (不新增行);
//                                           措辞变了 => 迁移 (新行 + 相似度留档)。
//
// 两类槽位的一个真实差别 (不是疏漏): 立场槽的值是**互斥**的 (对同一对象的态度只有一个),
// 所以同一槽位出现多条生效行是"历史遗留并列", 要标注 legacyCoexist;
// 而属性槽的值是**可以多元并存**的 ("这个角色的这个维度上"本来就可以有好几条互不冲突的观察),
// 相似度不足就不会被串进同一条链 —— 那是正常的多元观察, 不是遗留问题, 故不标注。
import { SLOT_MODEL } from '../domain/constants.js';
import { normalizeSlotValue } from '../utils/text.js';

const OP = Object.fromEntries(SLOT_MODEL.operations.map((o) => [o.value, o.label]));

/** 立场槽的键 (跨端一致: (持有者, 对象, 维度)) */
export function stanceSlotKey(s) {
  return `${s.holder_type}:${s.holder_id}>${s.target_type}:${s.target_id}@${s.stance_dimension}`;
}

/** 属性槽的键 (跨端一致: (实体, 维度)) */
export function attributeSlotKey(c) {
  return `${c.entity_type}:${c.entity_id}@${c.aspect}`;
}

/**
 * 沿 supersedes 指针回溯, 输出由旧到新的操作序列 (立场槽与属性槽共用的核心)。
 *
 * "值动没动"的判据: 立场比字符串, 属性比**规范化指纹** (normalizeSlotValue) ——
 * 后者让"换个标点""多个空白"不算一次迁移 (V8 的判据, 见 SLOT_MODEL.restatement)。
 *
 * @param {object} o
 * @param {(id:number)=>object|undefined} o.getRow  按 id 取行 (需能取到被覆盖的历史行)
 * @param {(row:object)=>number|null}     o.prevOf  取该行的前驱 id
 * @param {(row:object)=>string}          o.valueOf 取该行的"值" (已归一, 可直接比较)
 * @param {(row:object)=>string}          o.showOf 取该行的"值"的展示形态 (保留原文)
 */
function walkChain(headId, { getRow, prevOf, valueOf, showOf }) {
  const chain = [];
  const seen = new Set();
  let cur = getRow(headId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    const p = prevOf(cur);
    cur = p == null ? null : getRow(p);
  }
  chain.reverse();                                   // 旧 -> 新

  const steps = [];
  let prev = null;
  for (const row of chain) {
    const v = valueOf(row);
    if (!prev) {
      steps.push({ operation: 'create', value: showOf(row), at: row.created_at, rowId: row.id });
    } else if (valueOf(prev) === v) {
      // 旧数据可能留下同值相邻行 (V8 之前会写新行); 现在同值不写行, 只累加 confirms
      steps.push({ operation: 'confirm', value: showOf(row), at: row.created_at, rowId: row.id });
    } else {
      steps.push({
        operation: 'migrate', from: showOf(prev), value: showOf(row),
        at: row.created_at, rowId: row.id,
      });
    }
    // 该行自身的确认计数 (值没变时被再次观察到的次数), 紧跟其建立/迁移之后
    if ((row.confirms ?? 0) > 0) {
      steps.push({
        operation: 'confirm', value: showOf(row), at: row.updated_at,
        rowId: row.id, count: row.confirms,
      });
    }
    prev = row;
  }
  return { chain, steps };
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
  const getRow = (id) => byId.get(id) ?? db.prepare('SELECT * FROM stances WHERE id = ?').get(id);
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
    const { steps } = walkChain(current.id, {
      getRow,
      prevOf: (r) => r.supersedes_stance_id,
      valueOf: (r) => r.stance_type,
      showOf: (r) => r.stance_type,
    });
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
      transitions: steps.map((s) => ({ ...s, stanceId: s.rowId })),
      /** V6 及以前遗留的同槽位并存行 (只标注) */
      legacyCoexist: legacy.map((l) => ({ id: l.id, value: l.stance_type })),
    });
  }
  return slots.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 属性槽的清单 (V8): 每个 (实体, 维度) 一个槽位, 槽位下可以有多条并存的观察链。
 *
 * 每条链 = 一条属性的"值的历史": 链头是当前值, 链身是它一路走来的迁移与确认。
 * `observations` = 该链被观察到的总次数 (Σ(1+confirms)) —— 与注入里的 ×N 同一个数,
 * 保证面板看到的和模型看到的口径一致。
 */
export function attributeSlots(db, { chatId = null, entityType = null, entityId = null } = {}) {
  const conds = [];
  const params = {};
  if (chatId) { conds.push('c.chat_id = @chatId'); params.chatId = chatId; }
  if (entityType) { conds.push('c.entity_type = @entityType'); params.entityType = entityType; }
  if (entityId != null) { conds.push('c.entity_id = @entityId'); params.entityId = entityId; }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // 全量取 (含被覆盖与被软删的历史行): 链要完整才能回溯
  const all = db.prepare(`
    SELECT c.id, c.entity_type, c.entity_id, c.aspect, c.content, c.importance,
           c.confirms, c.supersede_similarity, c.supersedes_chunk_id,
           c.is_active, c.valid_to_event_id, c.chat_id, c.created_at, c.updated_at
    FROM attribute_chunks c ${where}
    ORDER BY c.id
  `).all(params);
  if (all.length === 0) return [];

  // 被覆盖集合同样从**全表**算 (理由与立场槽一致: 撤销不回退)
  const superseded = new Set(
    db.prepare('SELECT supersedes_chunk_id AS id FROM attribute_chunks WHERE supersedes_chunk_id IS NOT NULL')
      .all().map((r) => r.id),
  );
  const byId = new Map(all.map((c) => [c.id, c]));
  const getRow = (id) => byId.get(id)
    ?? db.prepare('SELECT * FROM attribute_chunks WHERE id = ?').get(id);

  const nameOf = (type, id) => {
    const table = type === 'person' ? 'people' : type === 'location' ? 'locations' : null;
    if (!table) return null;
    return db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name ?? null;
  };

  const groups = new Map();
  for (const c of all) {
    // 只有"当前生效"的行能做链头: 未删除 + 未过期 + 没人覆盖它
    if (c.is_active !== 1 || c.valid_to_event_id != null || superseded.has(c.id)) continue;
    const key = attributeSlotKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const slots = [];
  for (const [key, headRows] of groups) {
    headRows.sort((a, b) => (b.importance - a.importance) || (b.id - a.id));
    const chains = headRows.map((h) => {
      const { chain, steps } = walkChain(h.id, {
        getRow,
        prevOf: (r) => r.supersedes_chunk_id,
        valueOf: (r) => normalizeSlotValue(r.content),   // 判等用指纹, 不是原文
        showOf: (r) => r.content,                        // 展示永远用原文
      });
      // 观察总次数 = 链上 Σ(1+confirms): 与注入的 ×N 同口径
      const observations = chain.reduce((n, r) => n + 1 + (r.confirms ?? 0), 0);
      return {
        chunkId: h.id,
        entityType: h.entity_type,
        entityId: h.entity_id,
        aspect: h.aspect,
        content: h.content,
        importance: h.importance,
        confirms: h.confirms ?? 0,
        observations,
        /** 该行的前驱余弦 (措辞变过才有值): 审计一次"值走了多远" */
        supersedeSimilarity: h.supersede_similarity,
        transitions: steps.map((s) => ({ ...s, chunkId: s.rowId })),
      };
    });
    const primary = chains[0];
    slots.push({
      key,
      kind: 'attribute',
      entityType: primary.entityType,
      entityId: primary.entityId,
      entityName: nameOf(primary.entityType, primary.entityId),
      aspect: primary.aspect,
      /** 槽位的"当前值"取 importance 最高的那条链头 (多元并存时只报主值) */
      value: primary.content,
      confirms: primary.confirms,
      observations: chains.reduce((n, c) => n + c.observations, 0),
      /** 同一槽位下并存的多条观察链 (属性可以多元并存, 这不是遗留数据) */
      chains,
    });
  }
  return slots.sort((a, b) => a.key.localeCompare(b.key));
}

/** 全聊天的立场迁移序列 (只看值真的变过的那些), 按时间正序 */
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

/** 全聊天的属性迁移序列 (只看值真的变过的那些), 按时间正序 */
export function attributeTransitions(db, { chatId = null, limit = 50 } = {}) {
  const out = [];
  for (const slot of attributeSlots(db, { chatId })) {
    for (const chain of slot.chains) {
      for (const t of chain.transitions) {
        if (t.operation !== 'migrate') continue;
        out.push({
          ...t,
          slotKey: slot.key,
          entityType: slot.entityType,
          entityName: slot.entityName,
          aspect: slot.aspect,
        });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-limit);
}

/** 汇总 (面板与统计用) */
export function slotSummary(db, { chatId = null } = {}) {
  const slots = stanceSlots(db, { chatId });
  const attributes = attributeSlots(db, { chatId });
  const transitions = stanceTransitions(db, { chatId });
  const attributeMoves = attributeTransitions(db, { chatId });

  const counts = { create: 0, migrate: 0, confirm: 0, revoke: 0 };
  for (const s of slots) for (const t of s.transitions) counts[t.operation] = (counts[t.operation] ?? 0) + 1;

  const attributeCounts = { create: 0, migrate: 0, confirm: 0, revoke: 0 };
  for (const s of attributes) {
    for (const c of s.chains) {
      for (const t of c.transitions) {
        attributeCounts[t.operation] = (attributeCounts[t.operation] ?? 0) + 1;
      }
    }
  }

  return {
    slots,
    /** V8: 属性槽 (观察内容的值历史) */
    attributeSlots: attributes,
    transitions,
    /** V8: 属性值的迁移 (措辞真的变过的那些) */
    attributeTransitions: attributeMoves,
    counts,
    attributeCounts,
    /** 标签取自 constants (跨端同源) */
    labels: OP,
    slotDefs: SLOT_MODEL.slotDefs,
    defaultDimension: SLOT_MODEL.stanceDefaultDimension,
    /** V8: 重述判据的说明 (面板/文档向用户解释"为什么同一句话只算一次") */
    restatement: SLOT_MODEL.restatement,
  };
}
