// GET /api/meta: 前后端唯一语义源 (契约描述端点)
//
// 目的: 前端 UI 的枚举项与标签、默认值、打分公式、阈值、按钮可用性与降级提示,
//       全部从这里读取 —— 前端不另行硬编码一份, 从结构上杜绝两端语义漂移。
//
// 实现原则: 本文件只做"汇总 + 反映运行时能力", 不定义任何新语义。
//           所有枚举/权重/阈值/默认值一律来自 domain/constants.js。
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/migrate.js';
import {
  SERVICE_NAME,
  MEMORY_TYPES, MEMORY_SCOPES, MEMORY_DEFAULTS,
  ENTITY_TYPES, CHUNKABLE_ENTITY_TYPES, STANCE_ENTITY_TYPES,
  ASPECT_SUGGESTIONS, STANCE_TYPE_SUGGESTIONS,
  CHUNK_DEFAULTS, STANCE_DEFAULTS,
  RETRIEVAL_SCORING, RETRIEVAL_FALLBACK_DEFAULTS, TOKEN_ESTIMATION, CONTEXT_SECTIONS, DIGEST_FORMAT,
  INJECTION_TABLES, VERB_LAYER,
  THRESHOLDS, SUMMARY_POLICY, FORGET_SCORING, FORGET_TABLES,
  RULES, ENDPOINTS,
} from '../domain/constants.js';

/** 把客户端自描述转成对外能力标记 (client 缺失时给出明确原因, 前端据此禁用按钮) */
function describeCapability(client, name, missing) {
  if (!client) {
    return {
      name, available: false, configured: false,
      provider: null, model: null, reason: missing,
    };
  }
  const d = typeof client.describe === 'function' ? client.describe() : {};
  const configured = d.configured === true;
  const { reason, ...rest } = d;
  return {
    name,
    // 透传客户端自描述的全部字段 (model/dim/timeoutMs/batchSize...),
    // 前端所需的一切运行时参数都在这里, 不需要前端写死
    ...rest,
    available: configured,
    configured,
    provider: d.provider ?? null,
    model: d.model ?? null,
    reason: configured ? null : (reason ?? '未配置'),
  };
}

/** 受约束枚举: 后端会校验, 前端应用下拉框 */
function constrained(options, note = null) {
  return { constrained: true, options, note };
}

/** 自由枚举: 后端不校验, 仅作输入提示, 前端应用可输入的 datalist */
function suggested(options, note = null) {
  return { constrained: false, options, note };
}

function toOption(value) {
  return typeof value === 'string' ? { value, label: value } : value;
}

export function buildMeta(db, { llm = null, embed = null, retrieval = {}, runtime = {} } = {}) {
  const llmCap = describeCapability(llm, 'llm', '服务端未初始化 LLM 客户端');
  const embedCap = describeCapability(embed, 'embedding', '服务端未初始化 embedding 客户端');

  return {
    ok: true,
    service: SERVICE_NAME,
    version: runtime.version ?? null,
    schemaVersion: getSchemaVersion(db),
    latestSupported: LATEST_SCHEMA_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),

    // ---------- 运行时能力 (决定前端哪些功能可用) ----------
    capabilities: {
      llm: llmCap,
      embedding: embedCap,
      vectorSearch: {
        available: embedCap.available,
        metric: THRESHOLDS.similarityMetric,
        strategy: 'in-memory-brute-force',
        approximate: false,
        reason: embedCap.available ? null : 'embedding 不可用, 该路召回关闭',
      },
      storage: { kind: 'sqlite', fts: 'FTS5', softDelete: true },
    },

    // ---------- 生效默认值 (服务端实际使用的值, 非文档承诺) ----------
    defaults: {
      retrieval: {
        topK: Number(retrieval.topK) || RETRIEVAL_FALLBACK_DEFAULTS.topK,
        tokenBudget: Number(retrieval.tokenBudget) || RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget,
        note: '请求体同名字段可覆盖; 服务端兜底值受 config.retrieval 影响',
      },
      memory: MEMORY_DEFAULTS,
      chunk: CHUNK_DEFAULTS,
      stance: STANCE_DEFAULTS,
      forget: FORGET_SCORING.defaults,
      summary: {
        triggerFloors: SUMMARY_POLICY.triggerFloors,
        maxBatchTokens: SUMMARY_POLICY.maxBatchTokens,
        maxSummaryChars: SUMMARY_POLICY.maxSummaryChars,
        keepRecentMessages: SUMMARY_POLICY.keepRecentMessages,
        importance: SUMMARY_POLICY.defaultImportance,
        // 前情提要段的 token 预算 (请求体 digestMaxTokens 可覆盖)
        digestMaxTokens: SUMMARY_POLICY.digest.maxTokens,
      },
    },

    // ---------- 枚举 ----------
    enums: {
      memoryType: constrained(MEMORY_TYPES, '写入时校验, 非法值返回 400'),
      memoryScope: constrained(MEMORY_SCOPES, '写入时校验; character 需 characterId'),
      entityType: suggested(ENTITY_TYPES, '库中为自由字符串, 无约束'),
      chunkableEntityType: constrained(
        CHUNKABLE_ENTITY_TYPES.map(toOption),
        '三阶观察抽取器实际支持的类型; 其余类型会被跳过并计入 skipped'
      ),
      stanceEntityType: constrained(
        STANCE_ENTITY_TYPES.map(toOption),
        '立场层多态: person 与 org 可互指'
      ),
      aspect: {
        constrained: false,
        byEntityType: ASPECT_SUGGESTIONS,
        note: '维度为自由字符串, 上列为建议值',
      },
      stanceType: suggested(
        STANCE_TYPE_SUGGESTIONS.map(toOption),
        '立场类型为自由字符串, 抽取器按语义生成; 上列为常见值'
      ),
      forgetTable: constrained(
        FORGET_TABLES.map((t) => ({ value: t.value, label: t.label, hasAccess: t.hasAccess })),
        '可参与遗忘衰减与恢复的表'
      ),
    },

    // ---------- 打分口径 (供前端原样展示, 不要前端重写公式) ----------
    scoring: {
      retrieval: RETRIEVAL_SCORING,
      forget: {
        ...FORGET_SCORING,
        tables: FORGET_TABLES,
      },
      tokenEstimation: TOKEN_ESTIMATION,
    },

    thresholds: THRESHOLDS,
    contextSections: CONTEXT_SECTIONS,
    // 注入表格化: 段落标题/行数上限/各段预算/立场显示规则 (前端只读不写死)
    injectionTables: INJECTION_TABLES,
    // 动词层与命题层: 题元角色/动词建议值/三轴取值/嵌套角色/边词表/对齐口径
    // (前端做下拉与展示用; 事实层与命题层的分路由服务端视图保证, 前端不判断)
    verbLayer: VERB_LAYER,
    // 前情提要段的文本形状: 前端展示用 (不解析), 与后端组装同源
    digestFormat: DIGEST_FORMAT,

    // ---------- 长对话压缩策略: 前端据此累计楼层并决定何时总结 ----------
    // 阈值属于跨端语义, 前端不另存一份; 设置里同名字段为 0/-1 时即"用这里的值"
    summaryPolicy: SUMMARY_POLICY,

    // ---------- 生效规则 (文案口径统一) ----------
    rules: RULES,

    // ---------- 端点契约: 前端据 needsLlm/needsEmbedding 决定按钮可用性 ----------
    endpoints: ENDPOINTS,

    // ---------- 边界 ----------
    limits: {
      auth: false,
      jsonBodyLimit: runtime.bodyLimit ?? null,
      boundTo: runtime.host ? `${runtime.host}:${runtime.port}` : null,
      note: '本服务无鉴权, 仅监听本机回环地址; 请勿绑定 0.0.0.0 或暴露到公网',
    },
    cors: runtime.cors ?? null,
  };
}
