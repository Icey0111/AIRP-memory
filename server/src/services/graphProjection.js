// 记忆网络图投影 (只读, 无副作用): 把"指称-述谓实例异质网络"按聊天投影成 节点+边,
// 供可视化窗口 (GET /graph) 消费。与注入表格同源同构 —— 注入是它的四种邻接投影,
// 这里是它本身的原始形态。
//
// 图式 (docs/graph-view.md): **节点是词汇, 边是角色, 线上零句子**。
//   ① 词表节点 (全图共享, 每个带 count = 复用度): 指称 / 时间 / 谓词 / 角色 / 真值 / 情态
//   ② 结构节点: 述谓实例 (每个 events 行一个; 标签只写谓词 + 通路坐标, 不写句子)
//   ③ 边: 每条边只携带**一个**来自 domain/constants 的抽象词
//      (发起者/对象/时间/地点/真值/情态/起因…) —— 拼接、计数后缀、"谁对谁在何时"这类
//      一句话形态一律不允许出现在边上 (那正是本投影要消灭的形态, 见 graph-view.md §2)。
//
// 只读红线: 本文件不写库、不改语义; 词表一律取自 constants (单一语义源), 由前端原样渲染。
import { VERB_LAYER, INJECTION_TABLES } from '../domain/constants.js';
import { listVocabulary } from './vocabularyService.js';

/** 无 time_id 的实例排在最末 (与 graphService 同一口径) */
const UNTIMED_ORDER = 2147483647;

/** 观察块正文截断: 图里只做提示, 全文在注入与检索里 */
const OBS_SNIPPET = 80;

/** 谓词缺省占位 (抽取失败/旧数据), 不静默丢弃实例 */
const UNKNOWN_VERB = '未归一';

// 词表: 只在这里把 constants 的枚举摊平成查表 (语义仍然只有一份定义处)
const ROLE_LABEL = new Map(VERB_LAYER.thematicRoles.map((r) => [r.value, r.label]));
const STATUS = new Map(VERB_LAYER.statuses.map((s) => [s.value, s]));
const ATTITUDE_LABEL = new Map(VERB_LAYER.attitudes.map((a) => [a.value, a.label]));
const SOURCE_LABEL = new Map(VERB_LAYER.sources.map((s) => [s.value, s.label]));
const PARENT_ROLE_LABEL = new Map(VERB_LAYER.parentRoles.map((r) => [r.value, r.label]));
const statusOf = (v) => STATUS.get(v) ?? { label: v, short: v };
const roleLabel = (v) => ROLE_LABEL.get(v) ?? v;

/** 聊天清单: 有实例或有记忆的 chatId 都算 (纯 summary 的会话也能看) */
export function listChats(db) {
  const rows = db.prepare(`
    SELECT chat_id AS chatId, count(*) AS n, 'event' AS kind
      FROM events WHERE is_active = 1 AND chat_id IS NOT NULL
     GROUP BY chat_id
    UNION ALL
    SELECT chat_id AS chatId, count(*) AS n, 'memory' AS kind
      FROM memories WHERE is_active = 1 AND chat_id IS NOT NULL
     GROUP BY chat_id
  `).all();
  const merged = new Map();
  for (const r of rows) {
    const cur = merged.get(r.chatId) ?? { chatId: r.chatId, events: 0, memories: 0 };
    if (r.kind === 'event') cur.events = r.n; else cur.memories = r.n;
    merged.set(r.chatId, cur);
  }
  return [...merged.values()].sort((a, b) => (b.events - a.events) || (b.memories - a.memories));
}

/**
 * 图投影。
 * @param {object} db
 * @param {{chatId?: string|null, withObservations?: boolean}} opts
 *   chatId=null 表示全部聊天 (实体表是全局的, 这里以"实例/立场/观察的引用"定边界)
 */
export function projectGraph(db, { chatId = null, withObservations = true } = {}) {
  const chatCond = chatId ? 'AND e.chat_id = ?' : '';
  const chatParams = chatId ? [chatId] : [];

  // ---- 述谓实例 (按世界内时间排序, order 就是时间轴刻度) ----
  const rows = db.prepare(`
    SELECT e.id, e.title, e.label, e.verb_type AS verbType, e.verb_surface AS verbSurface,
           e.polarity, e.tense, e.status, e.source_type AS sourceType,
           e.source_person_id AS sourcePersonId, e.attitude,
           e.parent_instance_id AS parentInstanceId, e.parent_role AS parentRole,
           e.predicate_id AS predicateId, e.attitude_id AS attitudeId,
           e.clause_id AS clauseId, e.status_id AS statusId,
           e.importance, e.confirms, e.time_id AS timeId, e.location_id AS locationId,
           e.process, e.result_text AS resultText,
           COALESCE(tp.seq, ${UNTIMED_ORDER}) AS timeSeq, tp.label AS timeLabel
      FROM events e LEFT JOIN time_points tp ON tp.id = e.time_id
     WHERE e.is_active = 1 ${chatCond}
     ORDER BY timeSeq ASC, e.id ASC
  `).all(...chatParams);

  // 通路编号 (坐标, 不是语义): #<timeSeq>.<k>, k = 同一时间节点内的实例序 —— 确定性派生
  const seqSeen = new Map();
  const instances = rows.map((e, i) => {
    const untimed = e.timeSeq === UNTIMED_ORDER;
    const seq = untimed ? 0 : e.timeSeq;
    const k = (seqSeen.get(seq) || 0) + 1;
    seqSeen.set(seq, k);
    const predicate = e.verbType || UNKNOWN_VERB;
    const sourceType = e.sourceType || 'narrator';
    const modality = sourceType === 'narrator'
      ? 'narrator'
      : `attitude:${e.attitude || 'attributed'}`;
    return {
      id: e.id, order: i + 1, coordinate: `#${seq}.${k}`,
      predicate, verbSurface: e.verbSurface || '',
      predicateUnknown: predicate === UNKNOWN_VERB,
      polarity: e.polarity || '+', tense: e.tense || 'past', status: e.status || 'asserted',
      truth: e.status || 'asserted',
      // V10 词表指针: 真假判定按这些 id 判"同不同一个词" (字符串只作兜底)
      predicateId: e.predicateId ?? null, attitudeId: e.attitudeId ?? null,
      clauseId: e.clauseId ?? null, statusId: e.statusId ?? null,
      sourceType, attitude: e.attitude || null, sourcePersonId: e.sourcePersonId ?? null,
      modality,
      timeId: e.timeId ?? null, timeLabel: e.timeLabel ?? null,
      locationId: e.locationId ?? null,
      confirms: e.confirms ?? 0, importance: e.importance ?? 0.5,
      parentInstanceId: e.parentInstanceId ?? null, parentRole: e.parentRole ?? null,
      // ---- 载荷 (数据, 不是语义): 只进侧栏与悬浮, 不上画布 ----
      title: e.title || '', process: e.process || '', resultText: e.resultText || '',
      label: e.label || '',
    };
  });
  const instanceIds = instances.map((e) => e.id);
  const byId = new Map(instances.map((e) => [e.id, e]));
  const evFilter = instanceIds.length ? `IN (${instanceIds.map(() => '?').join(',')})` : null;
  const evParams = instanceIds;

  // ---- 时间节点 (世界内时间轴, 本来就可复用; parentId 支持章节嵌套) ----
  const timeRows = chatId
    ? db.prepare('SELECT id, label, seq, parent_id AS parentId, note, period_id AS periodId FROM time_points WHERE chat_id = ? ORDER BY seq ASC').all(chatId)
    : db.prepare('SELECT id, label, seq, parent_id AS parentId, note, period_id AS periodId FROM time_points ORDER BY chat_id, seq ASC').all();

  // ---- 参与边: 人 --题元角色--> 实例 ----
  const participants = (evFilter
    ? db.prepare(`
        SELECT ep.event_id AS instance, ep.person_id AS entity, ep.role
          FROM event_participants ep
         WHERE ep.event_id ${evFilter}
      `).all(...evParams) : []);

  // ---- 实例间关系边: 因果 / 引出 / 前承 / 矛盾 / 条件 / 择一 ----
  const links = (evFilter
    ? db.prepare(`
        SELECT l.from_id AS "from", l.to_id AS "to", l.relation
          FROM event_links l
         WHERE l.from_id ${evFilter} AND l.to_id ${evFilter}
      `).all(...evParams, ...evParams) : []);

  // ---- 嵌套引述: 宿主 --命题宾语/条件前件/择一候选--> 从句 ----
  const nesting = instances
    .filter((e) => e.parentInstanceId != null && byId.has(e.parentInstanceId))
    .map((e) => ({
      parent: e.parentInstanceId, child: e.id,
      role: e.parentRole || 'comp', label: PARENT_ROLE_LABEL.get(e.parentRole || 'comp') || '命题宾语（从句）',
    }));

  // ---- 立场: 指称 → 指称 (有向, 当前生效) ----
  const stances = db.prepare(`
    SELECT holder_type AS holderType, holder_id AS holderId,
           target_type AS targetType, target_id AS targetId,
           stance_type AS stanceType, intensity, basis, chat_id AS chatId,
           valid_from_event_id AS fromEvent
      FROM stances
     WHERE is_active = 1 ${chatId ? 'AND chat_id = ?' : ''}
  `).all(...(chatId ? [chatId] : []));

  // ---- 观察锚点: 实例 --方面词--> 指称 (正文是载荷, 只在侧栏读) ----
  const observations = (withObservations && evFilter
    ? db.prepare(`
        SELECT entity_type AS entityType, entity_id AS entityId,
               valid_from_event_id AS instance, aspect, content
          FROM attribute_chunks
         WHERE is_active = 1 AND valid_from_event_id ${evFilter}
     ${chatId ? 'AND chat_id = ?' : ''}
      `).all(...evParams, ...(chatId ? [chatId] : []))
      : []).map((o) => ({ ...o, content: String(o.content ?? '').slice(0, OBS_SNIPPET) }));

  // ---- 指称集合 = 被上面任何边引用过的那些 (is_active=1) ----
  const personIds = new Set([
    ...participants.map((p) => p.entity),
    ...instances.map((e) => e.sourcePersonId).filter((v) => v != null),
    ...stances.filter((s) => s.holderType === 'person').map((s) => s.holderId),
    ...stances.filter((s) => s.targetType === 'person').map((s) => s.targetId),
    ...observations.filter((o) => o.entityType === 'person').map((o) => o.entityId),
  ]);
  const locationIds = new Set([
    ...instances.map((e) => e.locationId).filter((v) => v != null),
    ...stances.filter((s) => s.holderType === 'location').map((s) => s.holderId),
    ...stances.filter((s) => s.targetType === 'location').map((s) => s.targetId),
    ...observations.filter((o) => o.entityType === 'location').map((o) => o.entityId),
  ]);
  const orgIds = new Set([
    ...stances.filter((s) => s.holderType === 'org').map((s) => s.holderId),
    ...stances.filter((s) => s.targetType === 'org').map((s) => s.targetId),
    ...observations.filter((o) => o.entityType === 'org').map((o) => o.entityId),
  ]);
  const itemIds = new Set(observations.filter((o) => o.entityType === 'item').map((o) => o.entityId));

  const pickEntities = (table, ids, extra = '') => {
    if (!ids.size) return [];
    const ph = [...ids].map(() => '?').join(',');
    return db.prepare(`SELECT id, name, aliases, is_active ${extra} FROM ${table} WHERE id IN (${ph})`).all(...ids)
      .map((r) => ({ ...r, aliases: safeAliases(r.aliases) }));
  };

  // ---- 词表节点: 元数据读 value_nodes, **复用度按本图内的引用现算** ----
  // 元数据 (别名/上位类/待审) 来自真实元素表; count 必须是"本图里被引用了几次",
  // 所以按已经查出来的那些边现算 —— 否则切到单个聊天时, 复用度会把别的聊天也算进来。
  const meta = new Map();
  const metaById = new Map();
  for (const v of listVocabulary(db, {})) {
    meta.set(`${v.kind}:${v.name}`, v);
    metaById.set(v.id, v);
  }
  const vocabNode = (kind, word, count) => {
    const m = meta.get(`${kind}:${word}`);
    return {
      id: word, word, nodeId: m?.id ?? null, count,
      label: kind === 'status' ? (statusOf(word).short || word) : word,
      full: kind === 'status' ? statusOf(word).label : undefined,
      parentName: m?.parentName ?? null, status: m?.status ?? 'ok',
      source: m?.source ?? 'extracted', aliases: m?.aliases ?? [],
    };
  };
  const tally = (pairs) => {
    const m = new Map();
    for (const [kind, word] of pairs) {
      if (!word) continue;
      const key = `${kind}:${word}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  };
  const counts = tally([
    ...instances.map((e) => ['predicate', e.predicate]),
    ...participants.map((p) => ['role', p.role]),
    ...instances.map((e) => ['status', e.truth]),
    ...instances.filter((e) => e.parentRole).map((e) => ['clause', e.parentRole]),
    ...instances.filter((e) => e.attitude && e.sourceType !== 'narrator').map((e) => ['attitude', e.attitude]),
    ...stances.map((s) => ['stance_type', s.stanceType]),
    ...observations.map((o) => ['aspect', o.aspect]),
  ]);
  const vocabOf = (kind) => [...counts.entries()]
    .filter(([k]) => k.startsWith(kind + ':'))
    .map(([k, count]) => vocabNode(kind, k.slice(kind.length + 1), count))
    .sort((a, b) => (b.count - a.count) || String(a.id).localeCompare(String(b.id)));

  // 谓词的"原文写法" (verb_surface): 归一后仍保留原话, 悬浮里看得到 (词表节点不丢证据)
  const surfaces = new Map();
  for (const e of instances) {
    if (!e.verbSurface || e.verbSurface === e.predicate) continue;
    const list = surfaces.get(e.predicate) ?? [];
    if (!list.includes(e.verbSurface) && list.length < 5) list.push(e.verbSurface);
    surfaces.set(e.predicate, list);
  }
  const predicates = vocabOf('predicate').map((p) => ({ ...p, surfaces: surfaces.get(p.id) ?? [] }));

  const modalityMap = new Map();
  for (const e of instances) {
    const mLabel = e.sourceType === 'narrator'
      ? (SOURCE_LABEL.get('narrator') || '叙述者断言')
      // 情态是"受约束建议值"而非封闭枚举 (实测库里就有 声称/承诺/威胁/恳求 这类自由词):
      // 词表外的原样保留, 一律兜底成同一个"声称"会把它们糊成一团
      : (ATTITUDE_LABEL.get(e.attitude) || e.attitude || '声称');
    const mo = modalityMap.get(e.modality) ?? { id: e.modality, word: e.attitude ?? 'narrator', label: mLabel, count: 0 };
    mo.count++; modalityMap.set(e.modality, mo);
  }
  const timeCount = new Map();
  for (const e of instances) if (e.timeId != null) timeCount.set(e.timeId, (timeCount.get(e.timeId) || 0) + 1);
  // 时段: 时间点的抽象层 (昼/夜/黄昏…) —— 复用度 = 有多少个时间点属于它
  const periodCount = new Map();
  for (const t of timeRows) if (t.periodId != null) periodCount.set(t.periodId, (periodCount.get(t.periodId) || 0) + 1);

  const timePoints = timeRows.map((t) => ({
    ...t, parentId: t.parentId ?? null, count: timeCount.get(t.id) || 0,
    periodId: t.periodId ?? null,
    periodName: t.periodId != null ? (metaById.get(t.periodId)?.name ?? null) : null,
  }));
  const timeParents = timePoints
    .filter((t) => t.parentId != null && timePoints.some((x) => x.id === t.parentId))
    .map((t) => ({ child: t.id, parent: t.parentId }));
  const periods = [...periodCount.entries()]
    .map(([id, count]) => vocabNode('time', metaById.get(id)?.name ?? String(id), count))
    .sort((a, b) => (b.count - a.count) || String(a.id).localeCompare(String(b.id)));

  const sortByCount = (m) => [...m.values()].sort((a, b) => (b.count - a.count) || String(a.id).localeCompare(String(b.id)));

  return {
    ok: true,
    // 图式版本: 静态页与投影是一对, 版本不符要**明说**而不是画出一张空图
    schema: 'graph-view/v2',
    chatId: chatId ?? null,
    chats: listChats(db),
    nodes: {
      // 指称层 (跨实例复用)
      people: pickEntities('people', personIds, ', person_type AS type, description'),
      locations: pickEntities('locations', locationIds, ', description'),
      orgs: pickEntities('orgs', orgIds, ', description'),
      items: pickEntities('items', itemIds, ', description'),
      // 时间层 (跨实例复用; 章节用 parentId, 时段用 periodId)
      timePoints,
      periods,
      // 词表层 (全图共享, 来自 value_nodes): 带 别名(写法)/上位类/待审状态/复用度
      predicates,
      roles: vocabOf('role'),
      truths: vocabOf('status'),
      attitudes: vocabOf('attitude'),
      clauses: vocabOf('clause'),
      aspects: vocabOf('aspect'),
      stanceTypes: vocabOf('stance_type'),
      modalities: sortByCount(modalityMap),
      // 结构层: 述谓实例 (簇的锚点; 标签只写谓词 + 坐标)
      instances,
    },
    edges: {
      // 每条边只写一个抽象词 (label 一律取自 constants)
      roles: participants.map((p) => ({ ...p, entityType: 'person', label: roleLabel(p.role) })),
      predicates: instances.map((e) => ({ instance: e.id, predicate: e.predicate })),
      times: instances.filter((e) => e.timeId != null).map((e) => ({ instance: e.id, time: e.timeId })),
      places: instances.filter((e) => e.locationId != null).map((e) => ({ instance: e.id, place: e.locationId })),
      truths: instances.map((e) => ({ instance: e.id, truth: e.truth })),
      modalities: instances.map((e) => ({ instance: e.id, modality: e.modality })),
      // 担保持有者: 归属命题必须能指回"谁说的" (docs/verb-layer.md §4.4)
      holders: instances.filter((e) => e.sourcePersonId != null)
        .map((e) => ({ instance: e.id, entity: e.sourcePersonId, entityType: 'person', label: '持有者' })),
      links: links.map((l) => ({ ...l, label: INJECTION_TABLES.linkLabels[l.relation] || l.relation })),
      nesting,
      timeParents,
      stances,
      observations,
    },
  };
}

function safeAliases(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
