// 只读图投影查询 (T2, docs/injection-tables.md §3.4 §4.2)
//
// 注入的表格不是几张互不相关的表, 而是同一张"实体-事件异质网络"的邻接投影:
//   chatTimeline -> 以时间节点为锚的事件邻接视图 (枢纽的行视图)
//   keyEntities  -> 节点目录 (排序依据 = 被事件引用的度数, 即图论意义上的热度)
//
// 本文件只读、无副作用、零表变更; 单元格文本的格式化留给 injectionService,
// 语义 (类型标签/排序口径/占位符) 一律取自 domain/constants.js 的 INJECTION_TABLES。
import { INJECTION_TABLES, VERB_LAYER } from '../domain/constants.js';

const T = INJECTION_TABLES.timeline;
const E = INJECTION_TABLES.entities;

/**
 * 事实层一律读 **v_facts** 视图 (V6): 视图已过滤 is_active=1 且 source_type='narrator'。
 * 为什么必须如此: 归属命题 (角色说的/想的) 一旦混进度数统计与事实检索, 模型就会把
 * "她声称的事"当成"确实发生的事" —— 这是比旧版吃书更隐蔽的错误。视图隔离让它在结构上不可能发生。
 *
 * ⚠️ 时间线是**唯一例外**, 它有意读 events 而非视图 (见 chatTimeline 内注释):
 *    已定局的声称 (已证实/已被拆穿) 本身就是剧情事实, 应当以来源口吻出现在时间线上。
 */
const FACT_STATUS_PH = VERB_LAYER.timelineStatuses.map(() => '?').join(', ');

/** 无 time_id 的事件排在最末: 用一个大于任何真实 seq 的哨兵值参与排序 */
const UNTIMED_ORDER = 2147483647;

function parseAliases(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((a) => typeof a === 'string' && a.trim()) : [];
  } catch {
    return [];
  }
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * 事件时间线: 取当前聊天最近的 limit 个事件, 连同时间节点/章节/地点/参与者/因果边。
 *
 * - 取"最近 N 个"用 (time.seq, id) 倒序取, 再翻回正序展示 —— 保证展示是叙事顺序;
 * - 因果边按下面的方向各渲染一次, 同一条边不会在两行里重复出现:
 *   caused 入边 / led_to 出边 / preceded 入边 / contradicts 双向;
 * - 边的对端事件可以落在窗口之外 (只取标题), 这样跨窗口的因果线不会断。
 */
export function chatTimeline(db, { chatId, limit = INJECTION_TABLES.limits.timelineRows } = {}) {
  if (!chatId || limit <= 0) return [];

  // 多取一些再筛 (密度控制会丢掉部分行, 见 §10.3)
  // 注意这里读的是 events 而非 v_facts: 时间线要收"已定局的声称"
  // (已证实 = 陈述为真; 已被拆穿 = 撒谎/记错)。这两类本身就是剧情事实,
  // 渲染时会带上来源口吻与定局标记 (injectionService.eventText), 不会伪装成叙述者事实。
  // 未决 (pending) 与未发生 (落空/未激活/作废) 一律不收 —— 见 constants 的分组口径。
  const headroom = Math.max(limit * 3, limit + 8);
  const rows = db.prepare(`
    SELECT e.id, e.title, e.process, e.cause_text, e.result_text, e.importance,
           e.verb_type, e.verb_surface, e.status, e.tense, e.polarity,
           e.source_type, e.attitude, e.source_person_id, e.parent_instance_id, e.parent_role,
           hp.name AS holder_name,
           e.time_id,
           t.label  AS time_label, t.seq AS time_seq,
           tp.id    AS chapter_id, tp.label AS chapter_label,
           l.name   AS location_name
    FROM events e
    LEFT JOIN people       hp ON hp.id = e.source_person_id
    LEFT JOIN time_points t  ON t.id = e.time_id
    LEFT JOIN time_points tp ON tp.id = t.parent_id
    LEFT JOIN locations   l  ON l.id = e.location_id
    WHERE e.chat_id = ? AND e.is_active = 1 AND e.status IN (${FACT_STATUS_PH})
      -- 子实例 (从句/条件前件/择一候选) 不作为独立行出现: 它们的内容由宿主行承载
      -- (否则「她说：X」和 X 会各占一行, 同一件事说两遍)
      AND e.parent_instance_id IS NULL
    ORDER BY COALESCE(t.seq, ${UNTIMED_ORDER}) DESC, e.id DESC
    LIMIT ?
  `).all(chatId, ...VERB_LAYER.timelineStatuses, headroom);

  if (rows.length === 0) return [];
  rows.reverse(); // 展示按叙事正序

  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);

  const participants = db.prepare(`
    SELECT ep.event_id, p.name, ep.role
    FROM event_participants ep
    JOIN people p ON p.id = ep.person_id
    WHERE ep.event_id IN (${ph})
    ORDER BY ep.event_id, p.name
  `).all(...ids);

  const links = db.prepare(`
    SELECT el.from_id, el.to_id, el.relation, fe.title AS from_title, te.title AS to_title
    FROM event_links el
    JOIN events fe ON fe.id = el.from_id
    JOIN events te ON te.id = el.to_id
    WHERE el.from_id IN (${ph}) OR el.to_id IN (${ph})
  `).all(...ids, ...ids);

  const partsByEvent = new Map();
  for (const p of participants) {
    if (!partsByEvent.has(p.event_id)) partsByEvent.set(p.event_id, []);
    partsByEvent.get(p.event_id).push({ name: p.name, role: p.role });
  }

  // 归属声称的内容在从句里: 渲染成「艾拉说：明天去镇上」, 故把 comp 子实例一并取出
  const comps = db.prepare(`
    SELECT id, parent_instance_id, title, verb_type, polarity, status, tense
    FROM events
    WHERE parent_instance_id IN (${ph}) AND parent_role = 'comp' AND is_active = 1
    ORDER BY id
  `).all(...ids);
  const compByParent = new Map();
  for (const c of comps) if (!compByParent.has(c.parent_instance_id)) compByParent.set(c.parent_instance_id, c);

  const linksByEvent = new Map();
  const pushLink = (eventId, relation, title) => {
    if (!linksByEvent.has(eventId)) linksByEvent.set(eventId, []);
    linksByEvent.get(eventId).push({ relation, title });
  };
  for (const l of links) {
    if (l.relation === 'caused' && l.to_id) pushLink(l.to_id, 'caused', l.from_title);
    else if (l.relation === 'led_to' && l.from_id) pushLink(l.from_id, 'led_to', l.to_title);
    else if (l.relation === 'preceded' && l.to_id) pushLink(l.to_id, 'preceded', l.from_title);
    else if (l.relation === 'contradicts') {
      // 矛盾是双向的: 两端各标一次 (这不是"同一条边渲染两遍", 而是两个事件各自的事实)
      pushLink(l.from_id, 'contradicts', l.to_title);
      pushLink(l.to_id, 'contradicts', l.from_title);
    }
  }

  const mapped = rows.map((r) => ({
    id: r.id,
    title: r.title,
    process: r.process,
    causeText: r.cause_text,
    resultText: r.result_text,
    importance: r.importance,
    verbType: r.verb_type,
    verbSurface: r.verb_surface,
    status: r.status,
    tense: r.tense,
    polarity: r.polarity,
    sourceType: r.source_type,
    attitude: r.attitude,
    holderName: r.holder_name,
    isProposition: r.source_type === 'attributed',
    comp: compByParent.get(r.id) ?? null,
    timeId: r.time_id,
    timeLabel: r.time_label,
    timeSeq: r.time_seq,
    chapterId: r.chapter_id,
    chapterLabel: r.chapter_label,
    locationName: r.location_name,
    participants: partsByEvent.get(r.id) ?? [],
    links: linksByEvent.get(r.id) ?? [],
  }));

  // 密度控制 (§10.3): 动词实例比旧版"事件"密得多, 只留"值得一提"的。
  // 保留条件: 有状态变化 / 在因果或条件边上 / 是归属声称 / importance 达标。
  const minImp = INJECTION_TABLES.timelineDensity.minImportance;
  const kept = mapped.filter((e) => (
    (e.resultText && e.resultText.trim())
    || e.links.length > 0
    || e.isProposition
    || e.importance >= minImp
  ));

  // 筛完仍按最近 limit 个 (保留最近: 时间线是近景视图)
  return kept.slice(-limit);
}

/**
 * 未决命题清单 (【待兑现】段的数据源, §10.2)。
 *
 * 口径: 本聊天 status='pending' 的实例 (含叙述者对未来的断言 —— 它同样"尚未发生")。
 * 内容优先取从句 (她说的事), 没有从句就用实例自身的标签。
 * 顺序: 保新丢旧 —— 与可见窗口相接的最近未决项最相关, 见 constants.pendingSection.rationale。
 */
export function chatPending(db, { chatId, limit = INJECTION_TABLES.limits.pendingRows } = {}) {
  if (!chatId || limit <= 0) return [];
  const ph = VERB_LAYER.pendingStatuses.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT e.id, e.title, e.verb_type, e.tense, e.source_type, e.attitude,
           hp.name AS holder_name,
           t.label AS time_label, t.seq AS time_seq
    FROM events e
    LEFT JOIN people       hp ON hp.id = e.source_person_id
    LEFT JOIN time_points t  ON t.id = e.time_id
    WHERE e.chat_id = ? AND e.is_active = 1 AND e.status IN (${ph})
    ORDER BY e.id DESC
    LIMIT ?
  `).all(chatId, ...VERB_LAYER.pendingStatuses, limit);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const comps = db.prepare(`
    SELECT parent_instance_id, title, verb_type FROM events
    WHERE parent_instance_id IN (${placeholders(ids.length)}) AND parent_role = 'comp' AND is_active = 1
    ORDER BY id
  `).all(...ids);
  const compByParent = new Map();
  for (const c of comps) if (!compByParent.has(c.parent_instance_id)) compByParent.set(c.parent_instance_id, c);

  return rows.map((r) => {
    const comp = compByParent.get(r.id) ?? null;
    return {
      id: r.id,
      verbType: r.verb_type,
      tense: r.tense,
      sourceType: r.source_type,
      attitude: r.attitude,
      holderName: r.holder_name,
      content: comp?.title || comp?.verb_type || r.title,
      anchor: r.time_label ?? null,
      timeSeq: r.time_seq ?? null,
    };
  }).reverse(); // 展示按剧情先后
}

/**
 * 关键实体: 人物/地点/物品/组织的规范速写 + 复现计数。
 *
 * - 度数 = 该实体被本聊天生效事件引用的次数 (person 走 event_participants,
 *   location 走 events.location_id, item/org 走 memory_entity_refs 引用桥);
 * - 窗口内度数再加一次权 (windowWeight) —— 时间线上正在发生的热点排更前;
 * - 速写: description 优先, 为空取该实体最高 importance 的生效观察块 (链头);
 * - 复现计数 ×N = 链头的 supersedes 链深度 (L2 观察折叠的可视化, §4.3)。
 */
export function keyEntities(db, { chatId, limit = INJECTION_TABLES.limits.entityRows, windowIds = [] } = {}) {
  if (!chatId || limit <= 0) return [];

  const win = [...new Set(windowIds.filter((x) => Number.isInteger(x)))];
  const winPh = win.length ? placeholders(win.length) : null;
  const winClause = winPh ? ` AND e.id IN (${winPh})` : '';

  const degreeOf = {
    person: db.prepare(`
      SELECT ep.person_id AS id, COUNT(*) AS n
      FROM event_participants ep
      JOIN v_facts e ON e.id = ep.event_id
      WHERE e.chat_id = ?
      GROUP BY ep.person_id
    `).all(chatId),
    location: db.prepare(`
      SELECT e.location_id AS id, COUNT(*) AS n
      FROM v_facts e
      WHERE e.chat_id = ? AND e.location_id IS NOT NULL
      GROUP BY e.location_id
    `).all(chatId),
    item: db.prepare(`
      SELECT r.entity_id AS id, COUNT(*) AS n
      FROM memory_entity_refs r
      JOIN memories m ON m.id = r.memory_id
      WHERE r.entity_type = 'item' AND m.chat_id = ?
      GROUP BY r.entity_id
    `).all(chatId),
    org: db.prepare(`
      SELECT r.entity_id AS id, COUNT(*) AS n
      FROM memory_entity_refs r
      JOIN memories m ON m.id = r.memory_id
      WHERE r.entity_type = 'org' AND m.chat_id = ?
      GROUP BY r.entity_id
    `).all(chatId),
  };

  const windowDegreeOf = winPh ? {
    person: db.prepare(`
      SELECT ep.person_id AS id, COUNT(*) AS n
      FROM event_participants ep
      JOIN v_facts e ON e.id = ep.event_id
      WHERE e.chat_id = ?${winClause}
      GROUP BY ep.person_id
    `).all(chatId, ...win),
    location: db.prepare(`
      SELECT e.location_id AS id, COUNT(*) AS n
      FROM v_facts e
      WHERE e.chat_id = ? AND e.location_id IS NOT NULL${winClause}
      GROUP BY e.location_id
    `).all(chatId, ...win),
  } : {};

  // 一次取本聊天的全部观察块 (含已被折叠的历史块: 链深需要它们), 在 JS 里按实体归拢
  const chunks = db.prepare(`
    SELECT id, entity_type, entity_id, content, importance, supersedes_chunk_id, is_active
    FROM attribute_chunks
    WHERE chat_id = ?
  `).all(chatId);
  const chunksByEntity = new Map();
  for (const c of chunks) {
    const key = `${c.entity_type}:${c.entity_id}`;
    if (!chunksByEntity.has(key)) chunksByEntity.set(key, []);
    chunksByEntity.get(key).push(c);
  }

  const out = [];
  for (const type of E.types) {
    const src = E.sources[type];
    if (!src) continue;

    const total = new Map(degreeOf[type].map((r) => [r.id, r.n]));
    const inWin = new Map((windowDegreeOf[type] ?? []).map((r) => [r.id, r.n]));

    // 候选实体 = 本聊天有存在证据的 id: 被事件引用过, 或被本聊天观察块看过。
    // 先收 id 再按 IN 查名字 —— 不扫全表: 实体库是全局的, 全表扫会随库规模线性变慢,
    // 而入目录的门槛本来就是"在本聊天出场过" (见返回前的 filter)。
    const candidates = new Set(total.keys());
    for (const key of chunksByEntity.keys()) {
      const sep = key.indexOf(':');
      if (key.slice(0, sep) === type) candidates.add(Number(key.slice(sep + 1)));
    }
    if (!candidates.size) continue;
    const ids = [...candidates];
    const rows = db.prepare(`
      SELECT ${src.idCol} AS id, name, aliases, description
      FROM ${src.table}
      WHERE is_active = 1 AND ${src.idCol} IN (${placeholders(ids.length)})
    `).all(...ids);

    for (const r of rows) {
      const degree = total.get(r.id) ?? 0;
      const windowDegree = inWin.get(r.id) ?? 0;
      const list = chunksByEntity.get(`${type}:${r.id}`) ?? [];
      const { head, depth, topImportance } = analyseChunks(list);
      // 排序 = (总引用度数 + 窗口内度数) × 观察块最高 importance —— 复现频次即重要度。
      // 速写文本 (description 优先 / 链头观察) 与 ×N 标记的拼装属于排版, 交给 injectionService。
      const score = ((E.windowWeight - 1) * windowDegree + degree) * topImportance;
      out.push({
        type,
        id: r.id,
        name: r.name,
        aliases: parseAliases(r.aliases),
        description: r.description ?? '',
        degree,
        windowDegree,
        head,
        depth,
        topImportance,
        score,
      });
    }
  }

  // 入目录的门槛是"在本聊天里有存在证据" —— 被本聊天事件引用过, 或被本聊天的观察块看过。
  // 只有全局 description 而从未在本聊天出场过的实体不进注入: 实体表是这张图在当前聊天的
  // 节点目录, 不是全库实体dump (否则一条新开聊天会凭空冒出所有描述过的角色/地点)。
  return out
    .filter((e) => e.degree > 0 || e.head)
    .sort((a, b) => (b.score - a.score) || (b.degree - a.degree) || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);
}

/**
 * 观察块的链头与链深。
 * 链头 = 没有被任何块 supersede 的块 (可以有多条, 对应不同 aspect);
 * 速写取其中 importance 最高的一条; 链深 = 从链头往下走 supersedes 的层数 (含链头)。
 */
function analyseChunks(list) {
  if (list.length === 0) return { head: null, depth: 0, topImportance: 0 };
  const supersededIds = new Set(list.filter((c) => c.supersedes_chunk_id).map((c) => c.supersedes_chunk_id));
  const byId = new Map(list.map((c) => [c.id, c]));
  const heads = list.filter((c) => c.is_active === 1 && !supersededIds.has(c.id));
  if (heads.length === 0) return { head: null, depth: 0, topImportance: 0 };

  const depthFrom = (id) => {
    let n = 0;
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      n++;
      cur = cur.supersedes_chunk_id ? byId.get(cur.supersedes_chunk_id) : null;
    }
    return n;
  };

  let head = heads[0];
  let depth = depthFrom(head.id);
  for (const h of heads) {
    const d = depthFrom(h.id);
    if (h.importance > head.importance || (h.importance === head.importance && d > depth)) {
      head = h;
      depth = d;
    }
  }
  const topImportance = Math.max(...heads.map((h) => h.importance ?? 0.5));
  return { head, depth, topImportance: topImportance || 0.5 };
}
