// 注入闭环: 每轮生成前向服务端要记忆上下文, 拼进 prompt
//
// 时序 (对应 docs/api.md §10):
//   GENERATION_AFTER_COMMANDS -> POST /api/context -> setExtensionPrompt
//
// 降级原则: 注入失败绝不影响生成 —— 清掉本轮注入, 记一条 warn, 照常继续。
import {
  eventSource, event_types,
  extension_prompt_types, extension_prompt_roles, setExtensionPrompt,
} from '../../../../../script.js';
import { buildQuery, getChatId, getCharacterId } from './session.js';
import { EXT_KEY } from './settings.js';

// 下面两组是 SillyTavern 自身 API 的取值 (宿主语义, 不是后端语义)。
// 加防御性兜底, 以防宿主版本差异导致导入为 undefined。
const POSITION = extension_prompt_types ?? { IN_PROMPT: 0, IN_CHAT: 1 };
const ROLE = extension_prompt_roles ?? { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

const POSITION_BY_KEY = { in_prompt: POSITION.IN_PROMPT, in_chat: POSITION.IN_CHAT };
const ROLE_BY_KEY = { system: ROLE.SYSTEM, user: ROLE.USER, assistant: ROLE.ASSISTANT };

export function createInjector({ api, metaStore, getSettings, log, bus = null }) {
  let lastResult = null;
  let lastError = null;
  let inflight = null;

  function clearPrompt() {
    // 置空即可撤下注入; 位置参数对清空无影响
    setExtensionPrompt(EXT_KEY, '', POSITION.IN_PROMPT, 0, false, ROLE.SYSTEM);
  }

  function setPrompt(text, s) {
    const position = POSITION_BY_KEY[s.injectPosition] ?? POSITION.IN_PROMPT;
    const role = ROLE_BY_KEY[s.injectRole] ?? ROLE.SYSTEM;
    const depth = position === POSITION.IN_CHAT ? Math.max(0, Number(s.injectDepth) || 0) : 0;
    setExtensionPrompt(EXT_KEY, text, position, depth, false, role);
  }

  /** 组装 /api/context 请求体; 0 值的 topK/tokenBudget/digestMaxTokens 表示"用服务端默认", 不发送 */
  function buildPayload(query) {
    const s = getSettings();
    const payload = { query, chatId: getChatId(), characterId: getCharacterId() };
    if (Number(s.retrievalTopK) > 0) payload.topK = Number(s.retrievalTopK);
    if (Number(s.retrievalTokenBudget) > 0) payload.tokenBudget = Number(s.retrievalTokenBudget);
    if (Number(s.digestMaxTokens) > 0) payload.digestMaxTokens = Number(s.digestMaxTokens);
    return payload;
  }

  async function fetchContext(query, { signal } = {}) {
    return api.context(buildPayload(query), { signal });
  }

  /**
   * 生成前准备注入。返回本次结果或跳过原因; 不抛错 (调用方是事件回调, 抛错会打断生成)。
   */
  async function prepare() {
    const outcome = await prepareInner();
    if (bus) bus.emit({ type: 'inject', outcome });
    return outcome;
  }

  async function prepareInner() {
    const s = getSettings();

    if (!s.enabled || !s.injectEnabled) {
      clearPrompt();
      lastResult = null;
      return { skipped: '注入已关闭' };
    }
    if (!metaStore.isLoaded()) {
      // 契约未载入时不做任何注入: 宁可无记忆, 也不猜
      clearPrompt();
      lastResult = null;
      return { skipped: '契约未载入 (未连接记忆服务)' };
    }

    const query = buildQuery({ count: s.queryMessages, maxChars: s.queryMaxChars });
    if (!query) {
      clearPrompt();
      lastResult = null;
      return { skipped: '无可用查询文本' };
    }

    // 新一轮生成到来时取消上一次未完成的请求, 避免旧结果覆盖新结果
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    try {
      const data = await fetchContext(query, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return { skipped: '已被更新的生成请求取代' };

      const text = String(data?.text ?? '').trim();
      if (text) setPrompt(text, s);
      else clearPrompt();

      lastResult = { at: Date.now(), query, text, data };
      lastError = null;
      log.debug('注入已更新', {
        usedTokens: data?.usedTokens,
        profileCount: data?.profileCount,
        digestCount: data?.digestCount,
        digestTokens: data?.digestTokens,
        hitCount: data?.hitCount,
        chunkHitCount: data?.chunkHitCount,
      });
      return lastResult;
    } catch (err) {
      if (ctrl.signal.aborted) return { skipped: '请求已取消' };
      clearPrompt();
      lastResult = null;
      lastError = err.message;
      log.warn('记忆注入失败, 本轮不注入:', err.message);
      return { error: err.message };
    } finally {
      if (inflight === ctrl) inflight = null;
    }
  }

  /** 面板上的"检索预览": 用指定 query (或最近一条用户消息) 跑一次, 不改动注入状态 */
  async function preview(rawQuery) {
    const s = getSettings();
    if (!metaStore.isLoaded()) return { error: '契约未载入 (未连接记忆服务)' };
    const query = (rawQuery ?? '').trim()
      || buildQuery({ count: s.queryMessages, maxChars: s.queryMaxChars });
    if (!query) return { error: '没有可用的查询文本' };
    try {
      const [context, retrieve] = await Promise.all([
        fetchContext(query),
        api.retrieve({ ...buildPayload(query), withChunks: true }),
      ]);
      return { at: Date.now(), query, context, retrieve };
    } catch (err) {
      return { error: err.message };
    }
  }

  function bind() {
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
      if (dryRun) return;
      await prepare();
    });
    log.debug('已挂载 GENERATION_AFTER_COMMANDS 注入钩子');
  }

  function clear() {
    clearPrompt();
    lastResult = null;
  }

  return {
    bind,
    prepare,
    preview,
    clear,
    clearPrompt,
    getLast: () => lastResult,
    getLastError: () => lastError,
  };
}
