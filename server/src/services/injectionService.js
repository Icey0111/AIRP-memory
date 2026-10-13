// 常驻注入段: 画像表 / 立场表 / 关键实体表 / 事件时间线表
// (T1: §3.1 §3.2; T2: §3.4 §4.2 —— 见 docs/injection-tables.md)
//
// 分层原则:
//   本文件负责"取数 + 把单元格格式化成字符串",
//   排版 (对齐/截断/分组留空) 交给 tableRender.ts —— 那里是纯函数, 有快照测试钉死格式。
//   语义 (标题/行数上限/预算/立场显示规则) 一律取自 domain/constants.js 的 INJECTION_TABLES,
//   本文件不出现任何可被前端感知的字面量。
import { INJECTION_TABLES, VERB_LAYER } from '../domain/constants.js';
import { estimateTokens } from '../utils/text.js';
import { renderTable, createFirstOccurrenceTracker, displayWidth, truncateToWidth } from './tableRender.ts';
import { getProfile } from './profileService.js';
import { chatStances } from './stanceService.js';
import { chatTimeline, keyEntities, chatPending } from './graphService.js';

const T = INJECTION_TABLES;
const TL = T.timeline;

/** 强度三档: 避免把 0.57 这种连续噪声数字灌给模型 (§3.2) */
export function intensityLabel(v, bands = T.intensityBands, labels = T.intensityLabels) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return labels.mid;
  if (n < bands.low) return labels.low;
  if (n < bands.high) return labels.mid;
  return labels.high;
}

/**
 * 立场"表露"列: 一列压三个二阶维度 (对外表现 / 是否公开 / 对方是否知情)。
 * 例: 隐秘·表面友好·对方不知
 */
export function stanceDisplayText(s) {
  const d = T.stanceDisplay;
  const base = s.displayed_type ? `${d.disguisedPrefix}${s.displayed_type}` : d.plainLabel;
  const prefix = s.is_public ? '' : d.hiddenPrefix;
  const suffix = s.target_aware ? '' : d.unawareSuffix;
  return `${prefix}${base}${suffix}`;
}

/** 预算截行: 从尾部丢 (保新/保高分丢低分); minRows 是段的下限 (常驻段保 1 行, 检索段可为 0) */
function fitToBudget(spec, rows, maxTokens, { minRows = 1 } = {}) {
  const total = rows.length;
  let kept = rows.slice();
  let text = kept.length ? renderTable(spec, kept) : '';
  let tokens = estimateTokens(text);
  while (kept.length > minRows && maxTokens > 0 && tokens > maxTokens) {
    kept = kept.slice(0, -1);
    text = kept.length ? renderTable(spec, kept) : '';
    tokens = estimateTokens(text);
  }
  if (kept.length === 0) return { text: '', count: 0, total, tokens: 0, dropped: total };
  return { text, count: kept.length, total, tokens, dropped: total - kept.length };
}

function parseChunkIds(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 【角色画像】表: 类别 / 条目 / 内容
 * - 按 category 分组 (getProfile 已按 category, key 排序), 同类别只在首行出现一次;
 * - 由观察块归纳的条目标 ※ (供人工核对哪些是推导来的, 不是人工设定);
 * - dedupeAgainst 传入立场表的对端名: 态度类条目与立场表重叠时以立场表为准 (L3 跨段去重)。
 */
export function buildProfileTable(db, {
  characterId,
  maxTokens = T.budgets.profile,
  limit = T.limits.profileRows,
  dedupeAgainst = [],
} = {}) {
  const rows = [];
  let total = 0;
  let deduped = 0;
  if (characterId) {
    const entries = getProfile(db, characterId);
    total = entries.length;
    const overlaps = T.dedupe.profileStanceOverlap
      ? dedupeAgainst.filter((n) => n && String(n).trim())
      : [];
    for (const p of entries) {
      if (overlaps.length && p.category === T.dedupe.profileCategory) {
        const text = `${p.key} ${p.value}`;
        if (overlaps.some((n) => text.includes(n))) { deduped++; continue; }
      }
      const derived = parseChunkIds(p.derived_from_chunk_ids).length > 0 ? ` ${T.derivedMark}` : '';
      rows.push({ cells: { category: p.category, key: p.key, value: `${p.value}${derived}` } });
    }
  }
  const capped = limit > 0 ? rows.slice(0, limit) : rows;
  const spec = {
    header: T.headers.profile,
    format: T.format.resident,
    groupKey: 'category',
    cellMaxWidth: T.limits.cellMaxWidth,
    columns: [
      { key: 'category', title: '类别' },
      { key: 'key', title: '条目' },
      { key: 'value', title: '内容' },
    ],
  };
  const fitted = fitToBudget(spec, capped, maxTokens);
  // total 以"截断前"的真实条数为准, 便于前端显示 "已注入 n/N"
  return {
    ...fitted,
    total: Math.max(rows.length, fitted.total),
    deduped,
    droppedByLimit: rows.length - capped.length,
  };
}

/**
 * 【关系立场】表: 持方 → 对方 / 立场 / 强度 / 表露 / 依据
 * - 口径 = 当前聊天全部生效立场 (is_active + 未过生效区间 + 未被覆盖);
 * - 两端名字都解析 (LLM 读不懂裸 id), 同持方相邻行"持方"列只出现一次;
 * - basis 为空显示占位符, 保住对齐。
 * 返回的 targets 供画像表做跨段去重 (不需要反解渲染文本)。
 */
export function buildStanceTable(db, { chatId, maxTokens = T.budgets.stances, limit = T.limits.stanceRows } = {}) {
  const list = chatStances(db, { chatId, limit });
  const rows = list.map((s) => ({
    cells: {
      holder: s.holder_name ?? `#${s.holder_id}`,
      target: s.target_name ?? `#${s.target_id}`,
      type: s.stance_type,
      intensity: intensityLabel(s.intensity),
      display: stanceDisplayText(s),
      basis: s.basis && String(s.basis).trim() ? String(s.basis) : T.stanceDisplay.emptyBasis,
    },
  }));
  const spec = {
    header: T.headers.stances,
    format: T.format.resident,
    groupKey: 'holder',
    cellMaxWidth: T.limits.cellMaxWidth,
    columns: [
      { key: 'holder', title: '持方' },
      { key: 'target', title: '对方' },
      { key: 'type', title: '立场' },
      { key: 'intensity', title: '强度' },
      { key: 'display', title: '表露' },
      { key: 'basis', title: '依据' },
    ],
  };
  const fitted = fitToBudget(spec, rows, maxTokens);
  const targets = [...new Set(rows.map((r) => r.cells.target).filter(Boolean))];
  return { ...fitted, total: Math.max(list.length, fitted.total), targets };
}

// ---------------------------------------------------------------
// T2: 关键实体表 + 事件时间线表
// ---------------------------------------------------------------

/**
 * 一次注入组装共享的上下文。
 * 追踪器跨段落共享, 是 L3 "首现展开、复现引用" 的实现: 关键实体表先渲染 (给全量速写),
 * 时间线里的同名人此后只出现纯名字 —— 同一名实在一次注入中最多全量描述一次 (§4.2)。
 */
export function createInjectionContext() {
  return { tracker: createFirstOccurrenceTracker() };
}

/** 名字单元格: 首现带速写 (≤ sketchMaxWidth), 非默认角色再追加角色注记 */
function entityCell(name, { tracker, sketch, role }) {
  const shown = tracker?.expand(name, sketch, T.sketchMaxWidth) || name;
  if (!role || role === TL.roleDefault) return shown;
  return shown.endsWith(')') && shown !== name
    ? `${shown.slice(0, -1)}, ${role})`
    : `${shown}(${role})`;
}

/**
 * 速写文本: description 优先, 为空取链头观察; 链深 ≥ 2 时追加 ×N。
 * ×N 先预留宽度再截断正文 —— 否则"被反复观察到的行为模式"这个最重要的信号
 * 会被单元格上限从尾部截掉 (这是实测发现的问题)。
 */
export function entitySketch(e) {
  const headText = String(e.head?.content ?? '').trim();
  const desc = String(e.description ?? '').trim();
  // description 与链头观察常常是同一句话的不同版本 (规范化描述 / 原始观察),
  // 已互相覆盖时只留一份 —— 这是 L1 归一的边界情形, 拼两遍就是把压缩又花回去
  const covered = desc && headText && (norm(desc).includes(norm(headText)) || norm(headText).includes(norm(desc)));
  let base = covered ? desc : (desc && headText ? `${desc}${T.entities.sketchSep}${headText}` : (desc || headText));
  if (!base) return '';
  const mark = e.depth >= 2 ? `${T.recurrenceMark}${e.depth}` : '';
  if (!mark) return base;
  const width = T.limits.cellMaxWidth;
  if (width > 0) {
    const reserve = displayWidth(mark) + 1;
    if (displayWidth(base) + reserve > width) {
      // 至少留出 1 显示宽的正文, 免得截断出空串
      base = truncateToWidth(base, Math.max(1, width - reserve), '');
    }
  }
  return `${base} ${mark}`;
}

/** 比较口径: 忽略空白与全角/半角标点差异 (仅用于判断"是否已覆盖") */
function norm(s) {
  return String(s ?? '').replace(/\s+/g, '').replace(/[,，;；。.]/g, '');
}

/**
 * 【关键实体】表: 实体 / 类型 / 别名 / 速写
 * - 排序 = 被事件引用度数 (时间线窗口内加权) × 观察块最高 importance —— 复现频次即重要度;
 * - 速写: description 优先, 为空取链头观察; 链深 ≥ 2 追加 ×N (L2 折叠的可视化, §4.3);
 *   ×N 是这张表里最有信息量的信号, 所以**先给它预留宽度再截断正文**, 不能被截断吃掉;
 * - 本表渲染过的名实会登记进共享追踪器, 使时间线不再重复展开速写。
 */
export function buildEntityTable(db, {
  chatId,
  windowIds = [],
  ctx,
  maxTokens = T.budgets.entities,
  limit = T.limits.entityRows,
} = {}) {
  const list = keyEntities(db, { chatId, limit, windowIds });
  const rows = [];
  const sketches = new Map();
  for (const e of list) {
    const sketch = entitySketch(e);
    sketches.set(e.name, sketch);
    // 登记首现 (输出即"名(速写)", 这里丢弃它: 本表的速写列要放全量文本, 由渲染器按单元格上限截断)
    if (sketch) ctx?.tracker.expand(e.name, sketch, T.sketchMaxWidth);
    rows.push({
      cells: {
        name: e.name,
        kind: T.entities.kindLabels[e.type] ?? e.type,
        aliases: e.aliases.length ? e.aliases.join(', ') : T.entities.noAlias,
        sketch: sketch || T.entities.emptySketch,
      },
    });
  }
  const spec = {
    header: T.headers.entities,
    format: T.format.resident,
    cellMaxWidth: T.limits.cellMaxWidth,
    columns: [
      { key: 'name', title: '实体' },
      { key: 'kind', title: '类型' },
      { key: 'aliases', title: '别名' },
      { key: 'sketch', title: '速写' },
    ],
  };
  const fitted = fitToBudget(spec, rows, maxTokens);
  // 已渲染的链头块 id: 供检索层做跨段去重 (§4.1 L3)。
  // 按 id 判重而不是按文本 —— 速写会为 ×N 预留宽度而被截断, 文本比对必然漏掉该去重的行。
  const headChunkIds = new Set(
    list.slice(0, fitted.count).map((e) => e.head?.id).filter(Boolean),
  );
  return {
    ...fitted,
    total: Math.max(list.length, fitted.total),
    sketches,
    headChunkIds,
    entities: list,
  };
}

/** 事件注记: 只写事件独有信息 (结果/经过), 不复述时间/人物/地点 (§4.6) */
export function eventNote(ev) {
  for (const src of TL.noteSources) {
    const v = String(ev[src === 'result_text' ? 'resultText' : src] ?? '').trim();
    if (v) return `${TL.notePrefix}${v}${TL.noteSuffix}`;
  }
  return '';
}

/**
 * 定局标记 (时间线内联用): 取 statuses 的 **short** 文案 (完整 label 太长, 会挤爆单元格)。
 * 只有"已证实 / 已被拆穿"两种定局值得标 —— 其余 (落空/未激活/作废) 根本不在时间线上。
 */
function statusMark(status) {
  const s = VERB_LAYER.statuses.find((x) => x.value === status);
  return (s && (s.short ?? s.label)) || '';
}

/**
 * 时间线「事件」列的正文 (V6 §10.1 + §4.4):
 *   叙述者事实 -> 标签 + 事件性注记
 *   归属声称   -> **必须带来源口吻**「艾拉说：明天去镇上（已证实）」,
 *                内容取从句 (她说的事), 没有从句则退回实例标签。
 * 来源口吻不可省: 少了它, 模型会把角色的话当世界真相 —— 比旧版吃书更隐蔽的错误。
 */
export function eventText(ev) {
  const note = eventNote(ev);
  if (!ev.isProposition) return `${ev.title}${note ? ` ${note}` : ''}`;

  const P = T.proposition;
  const actor = String(ev.holderName ?? '').trim();
  // 叙述者对未来的断言没有持有者 -> 不套"某人说"的口吻, 但也要标出未定局
  const voice = actor ? `${actor}${ev.attitude || P.fallbackAttitude}${P.joiner}` : '';
  const content = String(ev.comp?.title ?? ev.comp?.verbType ?? '').trim() || P.noContent;
  const mark = statusMark(ev.status);
  return `${voice}${content}${mark ? `（${mark}）` : ''}${note ? ` ${note}` : ''}`;
}

/**
 * 【待兑现】段 (§10.2): 未决命题清单。
 * 空则不出段; 行模板与文案取自 constants, 前端只展示不解析。
 */
export function buildPendingSection(db, { chatId, maxTokens = T.budgets.pending, limit = T.limits.pendingRows } = {}) {
  const list = chatPending(db, { chatId, limit });
  if (!list.length) return { text: '', count: 0, total: 0, tokens: 0, dropped: 0, ids: [] };

  const S = T.pendingSection;
  const lines = [];
  let used = estimateTokens(S.header);
  // 保新丢旧: chatPending 已按 id DESC 取最近 limit 条并按剧情先后返回
  for (const p of list) {
    const actor = p.holderName ? `${p.holderName}${p.attitude || T.proposition.fallbackAttitude}${T.proposition.joiner}` : '';
    const anchor = p.anchor ? `${S.anchorPrefix}${p.anchor}` : '';
    const line = S.line.replace('{actor}', actor).replace('{content}', p.content).replace('{anchor}', anchor);
    const cost = estimateTokens(`\n${line}`);
    if (lines.length > 0 && maxTokens > 0 && used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }
  const text = `${S.header}\n${lines.join('\n')}`;
  return {
    text, count: lines.length, total: list.length,
    tokens: estimateTokens(text), dropped: list.length - lines.length,
    ids: list.slice(0, lines.length).map((p) => p.id),
  };
}

/** 时间节点锚点: label #seq; 章节只在切换时出现一次 (§3.4) */
export function timeAnchor(ev, prevChapterId) {
  if (ev.timeId == null) return TL.untimedLabel;
  const seq = ev.timeSeq == null ? '' : `${TL.seqMark}${ev.timeSeq}`;
  const label = `${ev.timeLabel ?? ''}${seq ? ` ${seq}` : ''}`.trim();
  const chapter = ev.chapterLabel && ev.chapterId !== prevChapterId
    ? `${ev.chapterLabel}${TL.chapterSep}`
    : '';
  return `${chapter}${label}`;
}

/** 因果标注: 同一列压三类有向边, 每条边只渲染一次 (§3.4) */
export function causalText(links = []) {
  return links
    .map((l) => {
      const label = T.linkLabels[l.relation];
      return label && l.title ? `${label}: ${l.title}` : '';
    })
    .filter(Boolean)
    .join(TL.linkSep);
}

/**
 * 【事件时间线】表: 时间节点(分组锚点) / 事件 / 参与者 / 地点 / 因果标注
 * - 时间节点是行分组锚点: 同一节点只在首行出现一次 (时间维度的 L1 归一, §4.1)。
 *   注意这里**按 time_id 自己留空**, 而不是交给渲染器的 groupKey ——
 *   因为章节切换会给首行加前缀 ("第三章 / 第三夜 #7"), 同一节点的两行渲染文本并不相等,
 *   由文本比对驱动的 groupKey 会漏掉该留空的行;
 * - 参与者/地点是实体**名字**引用 (不裸 id), 并适用共享追踪器的首现展开;
 * - 事件列只写标题 + 事件性注记, 时间/人物/地点一律来自列引用 (列是真相源, §4.6)。
 */
export function buildTimelineTable(db, {
  chatId,
  ctx,
  sketches = new Map(),
  events = null,
  maxTokens = T.budgets.timeline,
  limit = T.limits.timelineRows,
} = {}) {
  const list = events ?? chatTimeline(db, { chatId, limit });
  const rows = [];
  let prevChapterId = null;
  let prevTimeId = null;
  for (const ev of list) {
    const anchor = timeAnchor(ev, prevChapterId);
    const sameNode = ev.timeId != null && ev.timeId === prevTimeId;
    prevChapterId = ev.chapterId ?? null;
    prevTimeId = ev.timeId ?? null;
    const participants = ev.participants
      .map((p) => entityCell(p.name, { tracker: ctx?.tracker, sketch: sketches.get(p.name), role: p.role }))
      .join(', ');
    rows.push({
      cells: {
        time: sameNode ? '' : anchor,
        event: eventText(ev),
        participants,
        location: ev.locationName ?? '',
        causal: causalText(ev.links),
      },
    });
  }
  const spec = {
    header: T.headers.timeline,
    format: T.format.resident,
    cellMaxWidth: T.limits.cellMaxWidth,
    columns: [
      { key: 'time', title: '时间节点' },
      { key: 'event', title: '事件' },
      { key: 'participants', title: '参与者' },
      { key: 'location', title: '地点' },
      { key: 'causal', title: '因果标注' },
    ],
  };
  const fitted = fitToBudget(spec, rows, maxTokens);
  return { ...fitted, total: Math.max(list.length, fitted.total), events: list };
}

/**
 * 检索层行化 (§3.5 §3.6): 紧凑 markdown 管道行, 不对齐、无分隔行。
 * rows 已按打分顺序; 超预算从尾部丢 (保高分丢低分), 可以为空 (检索段可以不出段)。
 */
export function buildRetrievedTable(spec, rows, maxTokens) {
  return fitToBudget({ ...spec, format: T.format.retrieved }, rows, maxTokens, { minRows: 0 });
}
