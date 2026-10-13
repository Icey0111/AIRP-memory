// 配置读写服务: 前端可视化填写模型配置, 密钥只落在服务端 config.json (gitignored)
//
// 设计 (为什么密钥不进前端, 但前端又要能填):
//   酒馆扩展的一切状态都存在 settings.json 里, 任何页面脚本可读、且会随配置导出/云同步走 ——
//   所以密钥**永远不进前端存储**。前端只做"输入壳": 密钥输入框 type=password 遮显,
//   提交后交给本服务写盘; 读取时密钥**打码回显** (••••+末4位, 只供辨认, 不能还原)。
//   回传打码值或空串 = "保持不变", 不会把已存的密钥冲掉。
//
//   写入是**深合并** + 字段白名单: 只接受 llm / embedding 两节的标量字段,
//   其余配置 (端口/数据库路径/CORS) 不允许从 HTTP 改 —— 改那些必须动文件并重启。
//   保存后**热重建** LLM/embedding 客户端, 无需重启服务 (重建经 index.js 注入的回调)。
import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 允许从 HTTP 写入的字段 (标量; 其余字段只能改文件) */
const WRITABLE_FIELDS = new Set([
  'provider', 'baseUrl', 'apiKey', 'model', 'timeoutMs', 'maxTokens', 'temperature', 'batchSize',
]);

const SECRET_FIELD = 'apiKey';
// 打码值里的圆点不可能出现在真实密钥里, 可安全用作"这是回显的打码值"的判定
const MASK_CHAR = '•';

function maskSecret(v) {
  const s = String(v ?? '');
  if (!s) return '';
  return MASK_CHAR.repeat(Math.min(8, Math.max(4, s.length - 4))) + s.slice(-4);
}

function sanitizeSection(section) {
  const out = {};
  for (const [k, v] of Object.entries(section ?? {})) {
    if (!WRITABLE_FIELDS.has(k)) continue;
    if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.filePath 用户配置文件路径 (server/config.json)
 * @param {object} o.defaults config.default.json 的内容 (合并底)
 * @param {(merged: object) => void} o.rebuild 用合并后的完整配置重建 LLM/embedding 客户端
 */
export function createConfigApi({ filePath, defaults, rebuild }) {
  if (!filePath || !defaults) throw new Error('configApi 需要 filePath 与 defaults');
  const userPath = filePath;

  function readUser() {
    try {
      return JSON.parse(fs.readFileSync(userPath, 'utf-8'));
    } catch {
      return {};                                   // 文件不存在或非法 => 视为空用户配置
    }
  }

  function merged() {
    return deepMerge(defaults, readUser());
  }

  /** 打码视图: 这就是 GET /api/config 返回的内容, 密钥不可还原 */
  function view() {
    const m = merged();
    const mask = (s) => {
      const out = { ...s };
      out.apiKey = maskSecret(s.apiKey);
      out.apiKeySet = Boolean(s.apiKey);
      return out;
    };
    return { llm: mask(m.llm ?? {}), embedding: mask(m.embedding ?? {}) };
  }

  function describe(client) {
    if (!client || typeof client.describe !== 'function') return null;
    return client.describe();
  }

  /** 深合并写入 + 持久化 + 热重建。返回打码视图与重建后的客户端自描述 */
  function update(patch) {    if (!isPlainObject(patch)) throw new Error('请求体必须是对象');
    const unknown = Object.keys(patch).filter((k) => !['llm', 'embedding'].includes(k));
    if (unknown.length) throw new Error(`不允许修改的配置节: ${unknown.join(', ')} (只接受 llm / embedding)`);
    for (const k of ['llm', 'embedding']) {
      if (patch[k] !== undefined && !isPlainObject(patch[k])) {
        throw new Error(`${k} 必须是对象`);
      }
    }

    const currentUser = readUser();
    const sanitized = {};
    for (const k of ['llm', 'embedding']) {
      if (patch[k] === undefined) continue;
      const sec = sanitizeSection(patch[k]);
      // 空 apiKey 或打码回显值 = "保持不变"; 不会把已存密钥冲掉
      if (SECRET_FIELD in sec) {
        const incoming = String(sec[SECRET_FIELD]);
        if (!incoming.trim() || incoming.includes(MASK_CHAR)) delete sec[SECRET_FIELD];
      }
      sanitized[k] = sec;
    }

    // 只把合法字段写进用户配置文件 (defaults 永远是合并底, 不落盘)
    const nextUser = deepMerge(currentUser, sanitized);
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, `${JSON.stringify(nextUser, null, 2)}\n`, 'utf-8');

    // 用合并后的完整配置热重建客户端
    const nextMerged = deepMerge(defaults, nextUser);
    if (typeof rebuild === 'function') rebuild(nextMerged);

    // 客户端自描述由调用方在 rebuild 后从 clients 持有者上取 (那里才是重建后的实例)
    return { config: view() };
  }

  /**
   * 拉取供应商的模型列表 (OpenAI 兼容 GET /models)。
   * 必须由服务端代理: apiKey 只在服务端, 前端永远不碰明文密钥。
   * kind ∈ llm | embedding; 返回模型 id 字符串数组。
   */
  /**
   * 模型列表核心: 用**给定**的 baseUrl/apiKey 探测供应商 GET /models。
   * 兜底尝试带/不带 /v1 两条路径; 失败抛出含具体 URL 的错误。
   */
  async function listModelsFor(kind, sec) {
    if (!sec.baseUrl) throw new Error('baseUrl 未填写');
    if (!sec.apiKey) throw new Error('apiKey 未填写');
    const base = String(sec.baseUrl).replace(/\/+$/, '');
    const candidates = base.endsWith('/v1')
      ? [`${base}/models`]
      : [`${base}/v1/models`, `${base}/models`];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${sec.apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastErr = new Error(`HTTP ${res.status}${body ? ` - ${body.slice(0, 200)}` : ''} (${url})`);
          continue;
        }
        const data = await res.json().catch(() => null);
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        const ids = list.map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name))).filter(Boolean);
        return [...new Set(ids)].sort();
      } catch (err) {
        lastErr = new Error(`无法访问 ${url} (${err.message})`);
      }
    }
    throw new Error(`拉取模型列表失败: ${lastErr?.message ?? '未知错误'}`);
  }

  async function listModels(kind) {
    if (kind !== 'llm' && kind !== 'embedding') throw new Error('kind 必须是 llm 或 embedding');
    return listModelsFor(kind, merged()[kind] ?? {});
  }

  /**
   * 用**用户正在输入、尚未保存**的 baseUrl/apiKey 试探拉取模型列表 (不落盘)。
   * 让用户在保存前就能看到模型下拉 —— 打错地址当场就能发现。
   */
  async function listModelsProvided({ kind, baseUrl, apiKey }) {
    if (kind !== 'llm' && kind !== 'embedding') throw new Error('kind 必须是 llm 或 embedding');
    return listModelsFor(kind, { baseUrl, apiKey });
  }

  return { view, update, describe, listModels, listModelsProvided };
}
