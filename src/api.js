// 记忆服务 HTTP 客户端
//
// 本层职责边界: 只负责"把请求发出去、把服务端的错误原样带回来"。
// 不内置任何后端语义 (枚举/默认值/权重/阈值) —— 那些由 src/meta.js 从 /api/meta 取得。
// 错误文案也一律取自服务端响应体, 前端不另写一套说法。

export class ApiError extends Error {
  constructor(message, { status = 0, path = '', cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    if (cause) this.cause = cause;
  }
}

// 前端自身的兜底网络超时 (由设置覆盖); 不是后端语义
const FALLBACK_TIMEOUT_MS = 15000;
// 存活探针的短超时
const PROBE_TIMEOUT_MS = 5000;

export function createApi(getSettings) {
  function resolveBase() {
    return String(getSettings()?.baseUrl ?? '').trim().replace(/\/+$/, '');
  }

  /**
   * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
   * @param {string} path
   * @param {{body?: any, timeoutMs?: number|null, signal?: AbortSignal|null}} [opts]
   */
  async function request(method, path, { body, timeoutMs = null, signal = null } = {}) {
    const base = resolveBase();
    if (!base) throw new ApiError('未配置记忆服务地址', { path });

    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw new ApiError('请求已取消', { path });
      signal.addEventListener('abort', forwardAbort, { once: true });
    }

    const configured = Number(getSettings()?.requestTimeoutMs);
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : (Number.isFinite(configured) && configured > 0 ? configured : FALLBACK_TIMEOUT_MS);
    const timer = setTimeout(() => ctrl.abort(), limit);

    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }

      // 服务端所有端点的错误包络都是 { ok:false, error:"..." }; 优先用它的文案
      if (!res.ok || data?.ok === false) {
        throw new ApiError(
          data?.error || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
          { status: res.status, path },
        );
      }
      return data ?? { ok: true };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err?.name === 'AbortError') {
        throw new ApiError(signal?.aborted ? '请求已取消' : `请求超时 (${limit}ms)`, { path, cause: err });
      }
      throw new ApiError(`无法连接记忆服务 (${base})`, { path, cause: err });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    request,
    health: () => request('GET', '/health', { timeoutMs: PROBE_TIMEOUT_MS }),
    status: () => request('GET', '/api/status'),
    meta: () => request('GET', '/api/meta'),

    context: (payload, opts) => request('POST', '/api/context', { body: payload, ...opts }),
    retrieve: (payload, opts) => request('POST', '/api/retrieve', { body: payload, ...opts }),

    extract: (payload, opts) => request('POST', '/api/extract', { body: payload, ...opts }),
    extractAttributes: (payload, opts) => request('POST', '/api/extract-attributes', { body: payload, ...opts }),
    extractStances: (payload, opts) => request('POST', '/api/extract-stances', { body: payload, ...opts }),
    deriveProfile: (payload, opts) => request('POST', '/api/profiles-derive', { body: payload, ...opts }),

    forget: (payload, opts) => request('POST', '/api/forget', { body: payload ?? {}, ...opts }),
    forgetRestore: (payload, opts) => request('POST', '/api/forget/restore', { body: payload, ...opts }),
  };
}
