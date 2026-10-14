// 注入段注册表: 段的顺序 / 依赖 / 预算 / 计数口径 全部声明在这里, 编排器只负责按声明跑。
//
// 为什么要有注册表 (而不是继续在编排器里手写八段):
//   之前段顺序、段间依赖 (实体表的速写要先进共享追踪器, 时间线才能只写纯名字)、
//   每段的统计字段全写在 assembleContext 里 —— 契约侧 CONTEXT_SECTIONS 声明的顺序
//   与实际组装顺序**没有任何机制绑定**, 改了一边另一边不会报错。
//   现在两边由 sectionOrder() / 测试钉在一起: 声明顺序 = 执行顺序 = 契约顺序。
//
// 两阶段执行 (与 dsh 的 mcp-client "Fetch/Swap" 同型):
//   prepare —— 取数/副作用, 依赖通过 deps 声明, 本模块做拓扑排序 (成环直接报错)
//   run     —— 渲染成段 + 产出计数, 按 order 升序执行
//   这样 profile 能用到 stances 取的立场做跨段去重, entities 能用到 timeline 取的窗口,
//   而**输出顺序**仍然是契约声明的 1..8 —— 取数顺序与出段顺序不再被迫一致。
import { INJECTION_TABLES } from '../domain/constants.js';
import { estimateTokens } from '../utils/text.js';
import {
  createInjectionContext, buildProfileTable, buildStanceTable,
  buildEntityTable, buildTimelineTable, buildRetrievedTable, buildPendingSection,
  buildClockAnchor, timeStamp,
} from './injectionService.js';
import { buildDigest } from './digestService.js';
import { chatTimeline } from './graphService.js';
import { getProfile } from './profileService.js';
import { resolveEntityName } from './stanceService.js';
import { searchMemories, searchChunks } from './memorySearch.js';
import { SUMMARY_MEMORY_TYPE } from '../domain/constants.js';

const T = INJECTION_TABLES;

// ============================================================
// 段定义
// ============================================================
// fields = 该段贡献给响应的字段及缺省值 (段被跳过时也要给出缺省, 否则前端拿到 undefined)。
// 字段名是对外契约的一部分: src/ui.js 与 check-contract.mjs 都在读, 改名属于破坏性变更。
export const INJECTION_SECTIONS = [
  {
    id: 'clock',
    key: 'clock',
    order: 1,
    deps: [],
    fields: { clockAt: null, clockText: '', clockInferred: false },
    // 时间锚 (V10): 上下文里那行"现在是几点"。基准取最近一条记录 (故事接着上一幕走),
    // 库里什么都没有才用服务端当前时间 —— 两种来源在文案上如实区分开。
    run(state) {
      const c = buildClockAnchor(state.db, { chatId: state.args.chatId });
      if (c.text) state.sections.push(c.text);
      return { clockAt: c.at, clockText: c.text, clockInferred: c.inferred };
    },
  },
  {
    id: 'stances',
    key: 'stances',
    order: 3,
    deps: [],
    fields: { stanceCount: 0, stanceTotal: 0, stanceTokens: 0, evolvedStanceCount: 0 },
    // 取数先于 profile: 画像表要拿立场表的对端名做跨段去重 (态度类条目以立场表为准)
    prepare(state) {
      if (!state.flags.stancesOn || !state.args.chatId) return;
      try {
        state.stance = buildStanceTable(state.db, { chatId: state.args.chatId });
      } catch (err) {
        console.warn(`[injection] 立场表渲染失败, 回退 bullet: ${err.message}`);
        state.fellBack = true;
      }
      state.stanceTargets = state.stance ? state.stance.targets : [];
    },
    run(state) {
      if (!state.stance) return null;
      const s = state.stance;
      if (s.text) state.sections.push(s.text);
      return {
        stanceCount: s.count,
        stanceTotal: s.total,
        stanceTokens: s.tokens,
        evolvedStanceCount: s.evolvedCount ?? 0,
      };
    },
  },
  {
    id: 'timeline',
    key: 'timeline',
    order: 6,
    deps: [],
    fields: {
      timelineCount: 0, timelineTotal: 0, timelineTokens: 0, timelineDropped: 0, propositionRows: 0,
    },
    // 取窗口事件: entities 段要用它算实体热度, 本段要用它渲染时间线 (同一次查询, 不查两遍)
    prepare(state) {
      if (!state.flags.tablesOn || !state.args.chatId) return;
      try {
        state.windowEvents = chatTimeline(state.db, { chatId: state.args.chatId });
      } catch (err) {
        console.warn(`[injection] 时间线取数失败: ${err.message}`);
        state.fellBack = true;
      }
    },
    run(state) {
      if (!state.flags.tablesOn || !state.args.chatId) return null;
      try {
        const t = buildTimelineTable(state.db, {
          chatId: state.args.chatId,
          ctx: state.ctx,
          sketches: state.sketches,
          events: state.windowEvents,
        });
        if (t.text) state.sections.push(t.text);
        return {
          timelineCount: t.count,
          timelineTotal: t.total,
          timelineTokens: t.tokens,
          timelineDropped: t.dropped,
          propositionRows: (t.events ?? []).slice(0, t.count).filter((e) => e.isProposition).length,
        };
      } catch (err) {
        console.warn(`[injection] 事件时间线渲染失败, 该段跳过: ${err.message}`);
        state.fellBack = true;
        return null;
      }
    },
  },
  {
    id: 'profile',
    key: 'profile',
    order: 2,
    deps: ['stances'],
    fields: { profileCount: 0, profileTotal: 0, profileTokens: 0, profileDropped: 0 },
    // 三级退化: 表格 -> bullet -> 整段跳过。任何一级失败都不许影响生成本身,
    // 所以回退路径自己也包了 try (回退不是"一定成功", 只是"更简单")。
    run(state) {
      const { db } = state;
      const { characterId } = state.args;
      if (!characterId) return null;
      if (state.flags.tablesOn) {
        try {
          const t = buildProfileTable(db, { characterId, dedupeAgainst: state.stanceTargets });
          if (t.text) state.sections.push(t.text);
          return {
            profileCount: t.count, profileTotal: t.total, profileTokens: t.tokens, profileDropped: t.dropped,
          };
        } catch (err) {
          console.warn(`[injection] 画像表渲染失败, 回退 bullet: ${err.message}`);
          state.fellBack = true;
        }
      }
      const b = safeProfileBullets(db, characterId);
      if (b.text) state.sections.push(b.text);
      return { profileCount: b.count, profileTotal: b.count, profileTokens: b.tokens, profileDropped: 0 };
    },
  },
  {
    id: 'entities',
    key: 'entities',
    order: 4,
    deps: ['timeline'],
    fields: { entityCount: 0, entityTotal: 0, entityTokens: 0, entityDropped: 0 },
    run(state) {
      if (!state.flags.tablesOn || !state.args.chatId) return null;
      try {
        const t = buildEntityTable(state.db, {
          chatId: state.args.chatId,
          ctx: state.ctx,
          windowIds: state.windowEvents.map((e) => e.id),
        });
        // 速写与链头块 id 交给后续段: 时间线复用速写, 相关细节按链头块 id 去重 (L3)
        state.sketches = t.sketches;
        state.headChunkIds = t.headChunkIds;
        if (t.text) state.sections.push(t.text);
        return {
          entityCount: t.count, entityTotal: t.total, entityTokens: t.tokens, entityDropped: t.dropped,
        };
      } catch (err) {
        console.warn(`[injection] 关键实体表渲染失败, 该段跳过: ${err.message}`);
        state.fellBack = true;
        return null;
      }
    },
  },
  {
    id: 'digest',
    key: 'digest',
    order: 5,
    deps: [],
    fields: {
      digestCount: 0, digestTotal: 0, digestTokens: 0, digestDropped: 0,
      digestTruncated: false, digestIds: [], digestMaxTokens: null,
      digestFromFloor: null, digestToFloor: null,
    },
    // 前情提要不参与相似度打分, 走自己的预算 —— 摘要覆盖的正文已被隐藏, 它是唯一载体
    run(state) {
      const d = buildDigest(state.db, {
        chatId: state.args.chatId,
        maxTokens: state.args.digestMaxTokens,
      });
      if (d.text) state.sections.push(d.text);
      return {
        digestCount: d.count,
        digestTotal: d.total,
        digestTokens: d.tokens,
        digestDropped: d.droppedCount,
        digestTruncated: d.truncated,
        digestIds: d.ids,
        digestMaxTokens: d.maxTokens,
        digestFromFloor: d.fromFloor,
        digestToFloor: d.toFloor,
      };
    },
  },
  {
    id: 'pending',
    key: 'pending',
    order: 7,
    deps: [],
    fields: { pendingCount: 0, pendingTotal: 0, pendingTokens: 0, pendingDropped: 0, pendingEnabled: true },
    run(state) {
      const on = state.args.injectPending !== false;
      state.pendingEnabled = on;
      if (!state.args.chatId || !on) return { pendingEnabled: on };
      const p = buildPendingSection(state.db, { chatId: state.args.chatId });
      if (p.text) state.sections.push(p.text);
      return {
        pendingCount: p.count, pendingTotal: p.total, pendingTokens: p.tokens, pendingDropped: p.dropped,
        pendingEnabled: on,
      };
    },
  },
  {
    id: 'memories',
    key: 'memories',
    order: 8,
    deps: [],
    fields: { hitCount: 0, hitIds: [] },
    run(state) {
      // 排除摘要: 摘要已由【前情提要】常驻, 再参与召回只会重复占位
      const { hits } = state.args.query
        ? searchMemories(state.db, {
          query: state.args.query, chatId: state.args.chatId, characterId: state.args.characterId,
          topK: state.args.topK, excludeTypes: [SUMMARY_MEMORY_TYPE],
        })
        : { hits: [] };
      if (!hits.length) return null;

      const left = () => state.args.tokenBudget - state.usedTokens;
      let count = 0;
      if (state.flags.tablesOn) {
        const rows = hits.map((h) => ({
          // V10 严格时间口径: 时间列只放精确时间戳 (该条记忆的写入时间), 剧情标签不进 prompt
          cells: { type: h.type, time: timeStamp(h.created_at), content: h.content, floor: floorOf(h) },
        }));
        const t = buildRetrievedTable({
          header: T.headers.memories,
          columns: [
            { key: 'type', title: '类型' },
            { key: 'time', title: T.timeColumnTitle },
            { key: 'content', title: '内容' },
            { key: 'floor', title: '楼层' },
          ],
        }, rows, left());
        count = t.count;
        state.usedTokens += t.tokens;
        if (t.text) state.sections.push(t.text);
      } else {
        const lines = [];
        for (const h of hits) {
          const when = timeStamp(h.created_at);
          const line = `- (${h.type}${when ? `, ${when}` : ''}) ${h.content}`;
          const cost = estimateTokens(line);
          if (state.usedTokens + cost > state.args.tokenBudget) break;
          lines.push(line);
          state.usedTokens += cost;
        }
        count = lines.length;
        if (lines.length) state.sections.push(`${T.headers.memories}\n${lines.join('\n')}`);
      }
      return { hitCount: count, hitIds: hits.slice(0, count).map((h) => h.id) };
    },
  },
  {
    id: 'chunks',
    key: 'chunks',
    order: 9,
    deps: ['entities'],
    fields: { chunkHitCount: 0, chunkHitIds: [], chunkError: null, chunkDeduped: 0 },
    // embedding 是外部网络依赖: 挂了/超时只该丢这一段, 绝不能让注入断供
    async run(state) {
      let chunkHits = [];
      let chunkError = null;
      try {
        ({ hits: chunkHits } = await searchChunks(state.db, state.embed, {
          query: state.args.query, chatId: state.args.chatId, topK: state.args.topK,
        }));
      } catch (err) {
        console.warn(`[injection] 向量召回失败, 跳过相关细节段: ${err.message}`);
        chunkError = err.message;
        state.fellBack = true;
      }
      // L3 跨段去重: 已由关键实体表的速写覆盖的观察块不重复渲染 —— 按块 id 判定 (精确),
      // 呈现层去重, 数据一字未删 (关掉 injectTables 就回来)
      const kept = chunkHits.filter((h) => !state.headChunkIds.has(h.id));
      const deduped = chunkHits.length - kept.length;
      if (!kept.length) return { chunkDeduped: deduped, chunkError };

      const left = () => state.args.tokenBudget - state.usedTokens;
      let count = 0;
      if (state.flags.tablesOn) {
        const rows = kept.map((h) => ({
          cells: {
            entity: resolveEntityName(state.db, h.entity_type, h.entity_id) ?? '',
            aspect: h.aspect,
            content: h.content,
          },
        }));
        const t = buildRetrievedTable({
          header: T.headers.chunks,
          columns: [
            { key: 'entity', title: '实体' },
            { key: 'aspect', title: '维度' },
            { key: 'content', title: '观察' },
          ],
        }, rows, left());
        count = t.count;
        state.usedTokens += t.tokens;
        if (t.text) state.sections.push(t.text);
      } else {
        const lines = [];
        for (const h of kept) {
          const line = `- [${h.aspect}] ${h.content}`;
          const cost = estimateTokens(line);
          if (state.usedTokens + cost > state.args.tokenBudget) break;
          lines.push(line);
          state.usedTokens += cost;
        }
        count = lines.length;
        if (lines.length) state.sections.push(`${T.headers.chunks}\n${lines.join('\n')}`);
      }
      return {
        chunkHitCount: count,
        chunkHitIds: kept.slice(0, count).map((h) => h.id),
        chunkDeduped: deduped,
        chunkError,
      };
    },
  },
];

// ============================================================
// 编排
// ============================================================

/** 出段顺序: 由每段声明的 order 决定, 与契约 CONTEXT_SECTIONS 的顺序一致 (测试钉死) */
export function sectionOrder(sections = INJECTION_SECTIONS) {
  return [...sections].sort((a, b) => a.order - b.order);
}

/**
 * 取数顺序: 按 deps 做拓扑排序。
 * 成环或依赖不存在的段直接抛错 —— 静默跳过依赖会让段拿到 undefined 的共享状态,
 * 表现为"某些字段偶尔是 0", 比启动即报错难查得多。
 */
export function prepareOrder(sections = INJECTION_SECTIONS) {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const out = [];
  const mark = new Map();
  const visit = (s, path) => {
    const st = mark.get(s.id);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`注入段依赖成环: ${[...path, s.id].join(' → ')}`);
    mark.set(s.id, 'visiting');
    for (const d of s.deps ?? []) {
      const dep = byId.get(d);
      if (!dep) throw new Error(`注入段 ${s.id} 声明了不存在的依赖: ${d}`);
      visit(dep, [...path, s.id]);
    }
    mark.set(s.id, 'done');
    out.push(s);
  };
  for (const s of sections) visit(s, []);
  return out;
}

/** 段声明的字段名全集 (供测试断言"没有字段在重构中丢失") */
export function sectionFields(sections = INJECTION_SECTIONS) {
  const out = {};
  for (const s of sectionOrder(sections)) Object.assign(out, s.fields);
  return out;
}

export function createState({ db = null, embed = null, args = {} } = {}) {
  const tablesOn = args.injectTables === false ? false : T.enabled;
  const stancesOn = tablesOn && args.injectStances !== false;
  return {
    db,
    embed,
    args,
    flags: { tablesOn, stancesOn },
    // 一次组装共享一个首现追踪器: 关键实体表先登记速写, 时间线里的同名人不再重复展开 (L3)
    ctx: createInjectionContext(),
    sections: [],
    usedTokens: 0,
    fellBack: false,
    // 段间共享状态 (由 prepare/前面的段填充)
    stance: null,
    stanceTargets: [],
    windowEvents: [],
    sketches: new Map(),
    headChunkIds: new Set(),
    fields: {},
  };
}

/** 跑注册表: 先按依赖取数, 再按 order 出段 */
export async function runSections(state, sections = INJECTION_SECTIONS) {
  for (const s of prepareOrder(sections)) {
    if (typeof s.prepare === 'function') await s.prepare(state);
  }
  for (const s of sectionOrder(sections)) {
    const fields = await s.run(state);
    if (fields) state.fields[s.id] = fields;
  }
  return state;
}

// ---------------------------------------------------------------
// 辅助 (原在 retrievalService 内, 随段一起搬过来)
// ---------------------------------------------------------------

function floorOf(memory) {
  try {
    const ids = JSON.parse(memory.source_message_ids ?? '[]');
    return Array.isArray(ids) && ids.length ? String(ids[0]) : '';
  } catch {
    return '';
  }
}

// 回退路径用的 bullet 画像块 (口径与表格化前完全一致)。
// 它自己也可能失败 (例如库读取异常) —— 那时画像段整体跳过, 不影响其余段落与生成。
function safeProfileBullets(db, characterId) {
  try {
    const profile = getProfile(db, characterId);
    if (!profile.length) return { text: '', count: 0, tokens: 0 };
    const lines = profile.map((p) => `- [${p.category}] ${p.key}: ${p.value}`);
    const text = `${T.headers.profile}\n${lines.join('\n')}`;
    return { text, count: profile.length, tokens: estimateTokens(text) };
  } catch (err) {
    console.warn(`[injection] 画像 bullet 回退同样失败, 该段跳过: ${err.message}`);
    return { text: '', count: 0, tokens: 0 };
  }
}
