// 后端契约的本地镜像 —— 前端一切的"语义来源"
//
// 设计要点 (对应"前后端语义一致"这条硬约束):
//   1. meta 为 null 表示"未连接/未载入契约"。此时所有访问器返回 null,
//      调用方必须显式处理"未知"状态, 不允许退回到本地硬编码的枚举或默认值。
//   2. 前端 UI 的枚举项、标签、默认值、公式、阈值、端点可用性判断, 全部读这里。
//   3. canCall() 依据服务端自己声明的 needsLlm/needsEmbedding 判定端点能否调用,
//      而不是前端自己写"有没有配 LLM"的判断逻辑。

export function createMetaStore(api, { bus = null, log = null } = {}) {
  let meta = null;      // GET /api/meta 的响应
  let status = null;    // GET /api/status 的响应
  let lastError = null;
  let loading = false;

  function snapshot() {
    return { meta, status, lastError, loading, loaded: meta !== null };
  }

  function emit() {
    if (bus) bus.emit({ type: 'meta', ...snapshot() });
  }

  /** 重新载入契约 + 运行时状态 (失败即把 meta 置空, 绝不保留过期契约) */
  async function refresh() {
    loading = true;
    emit();
    try {
      const [m, s] = await Promise.all([api.meta(), api.status()]);
      meta = m;
      status = s;
      lastError = null;
      if (log) log.info('契约已载入', { service: m.service, version: m.version, schemaVersion: m.schemaVersion });
    } catch (err) {
      meta = null;
      status = null;
      lastError = err.message;
      if (log) log.warn('契约载入失败:', err.message);
    } finally {
      loading = false;
    }
    emit();
    return snapshot();
  }

  function isLoaded() {
    return meta !== null;
  }

  function getMeta() {
    return meta;
  }

  function getStatus() {
    return status;
  }

  /** 取枚举描述对象 { constrained, options:[{value,label,...}], note } */
  function getEnum(name) {
    return meta?.enums?.[name] ?? null;
  }

  /** 取枚举选项数组; 未载入返回 null (调用方需处理) */
  function getEnumOptions(name) {
    return meta?.enums?.[name]?.options ?? null;
  }

  /** 由服务端标签渲染显示名; 未载入或未知值则原样返回 value */
  function label(enumName, value) {
    const found = getEnumOptions(enumName)?.find((o) => o.value === value);
    return found?.label ?? value;
  }

  function getDefaults() {
    return meta?.defaults ?? null;
  }

  function capability(name) {
    return meta?.capabilities?.[name] ?? null;
  }

  function getScoring() {
    return meta?.scoring ?? null;
  }

  function getThresholds() {
    return meta?.thresholds ?? null;
  }

  function getRules() {
    return meta?.rules ?? null;
  }

  function endpoint(method, path) {
    return (meta?.endpoints ?? []).find((e) => e.method === method && e.path === path) ?? null;
  }

  /**
   * 端点可用性判定 —— 完全依据服务端声明的依赖, 前端不自作判断。
   * @returns {{ ok: boolean, reason: string|null, endpoint: object|null }}
   */
  function canCall(method, path) {
    const ep = endpoint(method, path);
    if (!ep) return { ok: false, reason: '服务端未声明该端点 (契约未载入或版本不匹配)', endpoint: null };
    if (ep.needsLlm) {
      const cap = capability('llm');
      if (!cap?.available) return { ok: false, reason: `需要 LLM: ${cap?.reason ?? '不可用'}`, endpoint: ep };
    }
    if (ep.needsEmbedding) {
      const cap = capability('embedding');
      if (!cap?.available) return { ok: false, reason: `需要 embedding: ${cap?.reason ?? '不可用'}`, endpoint: ep };
    }
    return { ok: true, reason: null, endpoint: ep };
  }

  /**
   * 抽取类请求的 fetch 超时 —— 由服务端下发的 LLM 超时 + 前端余量推算, 不写死数字。
   * 契约未载入时返回 null, 交由 api 层用自身默认超时。
   */
  function llmRequestTimeoutMs(headroomMs = 5000) {
    const t = capability('llm')?.timeoutMs;
    return Number.isFinite(t) && t > 0 ? t + headroomMs : null;
  }

  return {
    refresh, snapshot, isLoaded, getMeta, getStatus,
    getEnum, getEnumOptions, label, getDefaults, capability,
    getScoring, getThresholds, getRules, endpoint, canCall, llmRequestTimeoutMs,
  };
}
