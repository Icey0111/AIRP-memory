// 长对话压缩闭环: 累计估算 token -> 达阈值 -> 压成摘要记忆 -> 隐藏已总结正文
//
// 硬性约定 (与后端 docs/api.md §12、/api/meta 对应):
//   阈值、下限、单批上限、摘要长度上限、建议保留条数、token 系数, 全部取自 /api/meta。
//   前端不写死任何一个数字; 契约未载入时整个功能不可用, 并如实说明原因。
//
// 两个边界的区分 (这是本模块的核心状态模型):
//   summarizedUpTo —— 已被总结覆盖到的楼层。用于"累计 token 从哪算起", 避免重复总结。
//   hiddenUpTo     —— 已被隐藏到哪一层。这些楼层不进 prompt, 也自然不计入累计。
//   两者的差额就是"已总结但仍保留在上下文里"的那几条 (为了让模型有逐字近因)。
//
// 覆盖边界必须用"实际进入摘要的最后一个楼层"(batch.lastIncluded), 而不是区间末端:
// 单批超出 maxBatchTokens 时只有前缀被摘要, 若把边界推进到区间末端,
// 那些没进摘要的楼层会被连带隐藏 —— 既不在摘要里, 也不在 prompt 里, 等于永久丢失。
//
// 为什么累计要"现算"而不是增量累加: 用户随时可能编辑/删除/撤销隐藏楼层,
// 增量计数会漂移。每次检查都按区间实算, 天然免疫。
import {
  collectRange, getChatId, getCharacterId,
  lastMessageIndex, setHidden, getChatState, setChatState, clearChatState,
} from './session.js';

export function createSummarizer({ api, metaStore, getSettings, log, bus }) {
  let running = false;
  let lastReport = null;

  function notify(phase) {
    if (bus) bus.emit({ type: 'summary', phase, report: lastReport, running });
  }

  function policy() {
    return metaStore.summaryPolicy();
  }

  /** 有效触发阈值: 面板填 0 表示"用服务端建议值"; 一律钳制在服务端给定的区间内 */
  function triggerTokens() {
    const p = policy();
    if (!p) return null;
    const user = Number(getSettings()?.summaryTriggerTokens);
    const base = Number.isFinite(user) && user > 0 ? user : Number(p.triggerTokens);
    if (!Number.isFinite(base) || base <= 0) return null;
    const lo = Number(p.limits?.min);
    const hi = Number(p.limits?.max);
    const lower = Number.isFinite(lo) && lo > 0 ? Math.max(base, lo) : base;
    return Number.isFinite(hi) && hi > 0 ? Math.min(lower, hi) : lower;
  }

  /** 有效保留条数: 面板填 -1 表示"用服务端建议值"; 0 = 被总结的正文全部隐藏 */
  function keepRecent() {
    const p = policy();
    const user = Number(getSettings()?.summaryKeepRecentMessages);
    const base = Number.isFinite(user) && user >= 0 ? user : Number(p?.keepRecentMessages);
    return Number.isFinite(base) && base > 0 ? Math.trunc(base) : 0;
  }

  function summarizedUpTo() {
    const v = Number(getChatState()?.summarizedUpTo);
    return Number.isFinite(v) ? v : -1;
  }

  function hiddenUpTo() {
    const v = Number(getChatState()?.hiddenUpTo);
    return Number.isFinite(v) ? v : -1;
  }

  /**
   * 待总结区间统计。
   * charCount 是区间内全部未隐藏正文的字符数 (不受 maxChars 影响), 用于阈值判断;
   * text 是按 maxChars 截断后的提交文本; lastIncluded 是提交文本覆盖到的最后楼层。
   */
  function pending({ maxChars = 0 } = {}) {
    const from = summarizedUpTo() + 1;
    const to = lastMessageIndex();
    if (to < from) {
      return {
        from, to, text: '', sourceMessageIds: [],
        messageCount: 0, charCount: 0, tokens: 0, lastIncluded: null,
      };
    }
    const range = collectRange({ fromIndex: from, toIndex: to, maxChars });
    return { ...range, tokens: metaStore.estimateTokensByChars(range.charCount) ?? 0 };
  }

  /** 供 UI 展示的运行状态 (不含任何硬编码阈值) */
  function status() {
    const st = pending();
    return {
      available: metaStore.summaryPolicy() !== null,
      triggerTokens: triggerTokens(),
      tokens: st.tokens,
      charCount: st.charCount,
      pendingMessages: st.messageCount,
      pendingFrom: st.from,
      lastMessageIndex: lastMessageIndex(),
      summarizedUpTo: summarizedUpTo(),
      hiddenUpTo: hiddenUpTo(),
      hiddenCount: hiddenUpTo() + 1,
      keepRecent: keepRecent(),
      running,
      lastReport,
    };
  }

  /** 楼层被删除/切换后, 记录可能越界 —— 越界即重置, 避免对错位的楼层动手 */
  function normalizeState() {
    const last = lastMessageIndex();
    const su = summarizedUpTo();
    const hu = hiddenUpTo();
    if ((su > last && su >= 0) || (hu > last && hu >= 0)) {
      log.warn('总结记录与当前楼层不符 (聊天可能被编辑过), 已重置边界');
      void setChatState({ summarizedUpTo: -1, hiddenUpTo: -1, resetReason: 'stale-index' });
      return true;
    }
    return false;
  }

  /**
   * 跑一次总结。永不抛错 —— 调用方可能是事件回调。
   * @param {'auto'|'manual'} trigger
   */
  async function run(trigger = 'manual') {
    if (running) return { skipped: '已有总结任务在进行中', trigger };

    const s = getSettings();
    if (!s.enabled) return { skipped: '记忆系统已关闭', trigger };
    if (trigger === 'auto' && !s.summaryEnabled) return { skipped: '自动总结已关闭', trigger };

    const p = policy();
    if (!p) return { skipped: '契约未载入, 无法确定总结阈值与长度上限', trigger };

    const gate = metaStore.canCall('POST', '/api/summarize');
    if (!gate.ok) return { skipped: gate.reason, trigger };

    normalizeState();

    const threshold = triggerTokens();
    const full = pending();
    if (!full.messageCount) return { skipped: '没有可总结的正文', trigger };

    if (trigger === 'auto') {
      if (!threshold) return { skipped: '服务端未下发可用阈值', trigger };
      if (full.tokens < threshold) {
        return { skipped: `累计约 ${full.tokens} token, 未达阈值 ${threshold}`, trigger };
      }
    }

    // 单批上限: 超出 maxBatchTokens 的部分留到下一批, 保证喂给 LLM 的 prompt 不撑爆上下文
    const cpt = metaStore.charsPerToken();
    const batchChars = Number.isFinite(Number(p.maxBatchTokens)) && cpt
      ? Math.max(1, Math.trunc(p.maxBatchTokens * cpt))
      : 0;
    const batch = batchChars ? pending({ maxChars: batchChars }) : full;
    if (!batch.text.trim()) return { skipped: '没有可提交的正文', trigger };

    // 覆盖边界 = 实际进入摘要的最后一个楼层, 而不是区间末端。
    // 单批受 maxBatchTokens 限制时只有前缀被摘要; 若把边界推进到区间末端,
    // 未进摘要的楼层会被随后的隐藏连带移出 prompt —— 既不在摘要里也不在上下文里, 等于丢数据。
    const coveredTo = batch.lastIncluded ?? batch.to;

    const report = {
      trigger,
      at: Date.now(),
      chatId: getChatId(),
      characterId: getCharacterId(),
      coveredFrom: batch.from,
      coveredTo,
      coveredSpan: coveredTo - batch.from + 1,
      // 本批是否因单批上限而只覆盖了区间的一部分 (余下留给下一批)
      batchTruncated: coveredTo < batch.to,
      messageCount: batch.messageCount,
      inputChars: batch.charCount,
      inputTokens: batch.tokens,
      threshold,
      keepRecent: keepRecent(),
      summaryMemoryId: null,
      deduped: false,
      truncated: false,
      hidden: null,
      error: null,
    };

    running = true;
    lastReport = report;
    notify('start');

    try {
      const timeout = metaStore.llmRequestTimeoutMs();
      const opts = timeout === null ? undefined : { timeoutMs: timeout };
      const res = await api.summarize({
        chatId: report.chatId,
        characterId: report.characterId,
        text: batch.text,
        sourceMessageIds: batch.sourceMessageIds,
        maxChars: Number(p.maxSummaryChars) || null,
      }, opts);

      report.summaryMemoryId = res.memoryId ?? res.memory?.id ?? null;
      report.deduped = res.deduped === true;
      report.truncated = res.truncated === true;

      // 已总结边界先推进: 即使随后的隐藏失败, 也不能让同一段被反复总结
      await setChatState({ summarizedUpTo: coveredTo, lastSummaryId: report.summaryMemoryId });

      // 隐藏被本次总结覆盖的正文, 但保留最近 keep 条 (keep=0 即全部隐藏)
      if (s.summaryHideAfter !== false) {
        const from = hiddenUpTo() + 1;
        const to = Math.max(from - 1, coveredTo - report.keepRecent);
        if (to >= from) {
          const r = await setHidden(from, to, true);
          report.hidden = r;
          if (r.ok) await setChatState({ hiddenUpTo: to });
        }
      }
    } catch (err) {
      report.error = err.message;
      log.warn(`总结失败 (不影响对话): ${err.message}`);
    } finally {
      running = false;
      notify('done');
    }

    if (!report.error) {
      log.debug('总结完成', {
        covered: `${report.coveredFrom}-${report.coveredTo}`,
        memoryId: report.summaryMemoryId,
        hidden: report.hidden,
      });
    }
    return report;
  }

  /** 每收到一条角色消息时的自动检查 */
  function noteMessage() {
    const s = getSettings();
    if (!s.enabled || !s.summaryEnabled) return;
    void run('auto');
  }

  /** 取消隐藏: 把已隐藏的正文全部放回 prompt (不动已总结边界, 免得同一段被重复总结) */
  async function unhideAll() {
    const hu = hiddenUpTo();
    if (hu < 0) return { skipped: '当前没有已隐藏的正文' };
    const r = await setHidden(0, hu, false);
    if (r.ok) await setChatState({ hiddenUpTo: -1 });
    notify('done');
    return r;
  }

  /** 清空本聊天的总结记录 (不动已写入的记忆, 也不动隐藏状态) */
  async function resetState() {
    await clearChatState();
    notify('done');
    return { ok: true };
  }

  return {
    run,
    noteMessage,
    unhideAll,
    resetState,
    status,
    pending,
    triggerTokens,
    keepRecent,
    getLast: () => lastReport,
    isRunning: () => running,
  };
}
