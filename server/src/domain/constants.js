// 领域常量: 前后端唯一语义源 (single source of truth)
//
// 约定 (重要):
//   1. 凡"跨端可见"的枚举/标签、打分权重与公式、阈值、默认值、生效规则文案,
//      一律只在本文件定义一次, service 与 GET /api/meta 均从此处派生。
//   2. 禁止在 service 层重复写这些字面量, 也禁止前端另写一份 —— 前端一切语义从 /api/meta 取。
//   3. 本文件不依赖任何运行时状态 (db/客户端/配置), 因此可被 api 层安全引用。

export const SERVICE_NAME = 'tavern-memory-server';

// ============================================================
// 一阶记忆
// ============================================================

/** 记忆类型。受约束 (写入时校验)。 */
export const MEMORY_TYPES = [
  { value: 'fact', label: '事实', description: '稳定的设定类信息, 如身份/关系/世界规则' },
  { value: 'event', label: '事件', description: '剧情中发生过的事, 有先后顺序' },
  { value: 'summary', label: '摘要', description: '一段剧情或一段时间的压缩概括' },
];

/** 作用域。受约束 (写入时校验)。顺序与 docs/api.md 一致。 */
export const MEMORY_SCOPES = [
  { value: 'character', label: '角色', description: '仅当前角色卡可见, 必须提供 characterId' },
  { value: 'chat', label: '聊天', description: '仅当前聊天会话可见, 必须提供 chatId' },
  { value: 'global', label: '全局', description: '所有上下文均可见' },
];

export const MEMORY_TYPE_VALUES = MEMORY_TYPES.map((t) => t.value);
export const MEMORY_SCOPE_VALUES = MEMORY_SCOPES.map((s) => s.value);

/** 一阶记忆默认值 (createMemory 的缺省参数) */
export const MEMORY_DEFAULTS = {
  scope: 'chat',
  importance: 0.5,
  emotionalWeight: 0,
};

// ============================================================
// 实体 (语义层)
// ============================================================

/** 实体类型全集。库中为自由字符串, 受约束的是下面两个子集。 */
export const ENTITY_TYPES = [
  { value: 'person', label: '人物' },
  { value: 'location', label: '地点' },
  { value: 'item', label: '物品' },
  { value: 'org', label: '组织' },
];

/**
 * 三阶观察块抽取器实际支持的实体类型 (受约束)。
 * 注意: item / org 的观察会被跳过并计入 skipped —— 表结构已支持, 抽取器未开。
 */
export const CHUNKABLE_ENTITY_TYPES = ['person', 'location'];

/** 立场层支持的实体类型 (受约束)。有向不对称, person / org 可互指。 */
export const STANCE_ENTITY_TYPES = ['person', 'org'];

/** 属性维度建议值 (自由字符串, 不受约束; 供前端做输入提示) */
export const ASPECT_SUGGESTIONS = {
  person: ['personality', 'appearance', 'speech', 'habit', 'relationship', 'skill'],
  location: ['scene', 'atmosphere', 'detail'],
};

/** 立场类型建议值 (自由字符串, 不受约束; 抽取器按语义自由生成) */
export const STANCE_TYPE_SUGGESTIONS = [
  '友好', '信任', '亲近', '爱慕', '尊敬',
  '中立', '疏离', '戒备', '敌视', '仇视', '利用',
];

/** 观察块默认值 */
export const CHUNK_DEFAULTS = { importance: 0.5 };

/** 立场默认值 (表里如一 / 公开 / 对方知情 的缺省) */
export const STANCE_DEFAULTS = {
  intensity: 0.5,
  importance: 0.5,
  isPublic: true,
  targetAware: true,
};

// ============================================================
// 检索打分 (retrievalService)
// ============================================================

/**
 * 三路召回 (FTS 记忆 / 向量观察块) 统一打分口径。
 * 公式文本供前端原样展示, 避免前端自己拼一套说法而和后端漂移。
 */
export const RETRIEVAL_SCORING = {
  weights: { relevance: 0.6, importance: 0.25, recency: 0.15 },
  formula: 'score = 0.6 × 相关性 + 0.25 × importance + 0.15 × 时间新近度',
  recencyHalfLifeDays: 30,
  recencyFormula: 'recency = exp(-ageDays × ln2 / 30), ageDays 从 last_accessed_at(无则 created_at) 起算',
  relevanceFormula: 'FTS: bm25 归一到 [0,1]; 向量: 余弦相似度归一到 [0,1]',
};

/** 检索默认值 (config.retrieval 覆盖不到时的兜底, 与 config.default.json 保持一致) */
export const RETRIEVAL_FALLBACK_DEFAULTS = { topK: 8, tokenBudget: 1200 };

/** token 估算口径: 前端展示预算时需知道后端怎么算的 */
export const TOKEN_ESTIMATION = {
  formula: '估算 token ≈ ⌈字符数 / 2⌉',
  description: '中英混合的保守估算, 不是真实分词',
};

/** 注入组装的段落填充顺序 */
export const CONTEXT_SECTIONS = [
  { order: 1, key: 'profile', label: '角色画像', description: '常驻保底, 预算外优先保证' },
  { order: 2, key: 'memories', label: '相关记忆', description: 'FTS 召回, 按打分顺序填预算' },
  { order: 3, key: 'chunks', label: '相关细节', description: '向量召回的观察块' },
];

// ============================================================
// 阈值 (防吃书)
// ============================================================

export const THRESHOLDS = {
  /** 同实体同维度, 新观察与旧块余弦 >= 此值 => 判定为同一属性的更新, 建立 supersedes 覆盖链 */
  supersedeSimilarity: 0.85,
  /** 相似度度量 */
  similarityMetric: 'cosine',
};

// ============================================================
// 遗忘衰减 (forgetService)
// ============================================================

/** 参与遗忘衰减的三张表。label 会出现在响应里, 前端直接展示。 */
export const FORGET_TABLES = [
  { value: 'memories', label: '记忆', hasAccess: true },
  { value: 'attribute_chunks', label: '观察块', hasAccess: true },
  { value: 'stances', label: '立场', hasAccess: false },
];

export const FORGET_TABLE_VALUES = FORGET_TABLES.map((t) => t.value);

export const FORGET_SCORING = {
  weights: { importance: 0.5, recency: 0.3, frequency: 0.2 },
  formula: 'score = 0.5 × importance + 0.3 × 时间新近度 + 0.2 × 访问频率',
  /** stances 无访问追踪列 (schema 冻结), 按 0.6/0.4 重归一 */
  noAccessWeights: { importance: 0.6, recency: 0.4 },
  noAccessFormula: 'score = 0.6 × importance + 0.4 × 时间新近度',
  halfLifeDays: 30,
  frequencySaturation: 10,
  frequencyFormula: 'frequency = min(访问次数 / 10, 1)',
  defaults: { threshold: 0.25, minAgeDays: 30, protectImportance: 0.9 },
  /** 保护规则文案 (前端原样展示) */
  protections: [
    'importance ≥ protectImportance 的条目不入选',
    '入库不足 minAgeDays 天的条目不入选',
  ],
};

// ============================================================
// 生效规则文案 (前端展示 / 人工核对用)
// ============================================================

export const RULES = {
  visibility:
    "scope='global' 全部可见; scope='character' 且 character_id 匹配当前角色; "
    + "scope='chat' 且 chat_id 匹配当前聊天。三者取并集。",
  softDelete: '所有 DELETE 均为软删除 (is_active=0), 数据仍在库中, 可经 /api/forget/restore 恢复。',
  supersede: '同实体同维度的新观察与旧块余弦相似度 ≥ 0.85 时自动建立 supersedes 覆盖链, 旧块转为历史不再生效。',
  stanceEvolution: '同 (holder, target, stance_type) 的新立场自动 supersedes 旧立场; 不同类型可并存。',
  currentFilter: '当前生效 = is_active=1 且未过 valid_to 区间 且未被新版本 supersedes。',
  entityIdDuality:
    '两套 id 体系: character_profiles.character_id 是角色卡名字符串; '
    + 'attribute_chunks.entity_id / stances.holder_id 是 people/orgs 表的整数 id。不可混用。',
  forgetRestoreScope: 'restore 仅作用于被遗忘 (is_active=0) 的条目, 对未遗忘条目返回 404。',
};

// ============================================================
// 端点契约 (能力依赖矩阵 / 降级策略)
// 前端据此决定按钮可用性与提示, 而不是自己写判断逻辑。
// ============================================================

/**
 * @typedef {Object} EndpointSpec
 * @property {string} method
 * @property {string} path
 * @property {string} summary
 * @property {boolean} needsLlm
 * @property {boolean} needsEmbedding
 * @property {'error'|'silent'} degrade 依赖缺失时的行为: error=返回 400; silent=静默降级
 * @property {string} degradeNote
 */

/** @type {EndpointSpec[]} */
export const ENDPOINTS = [
  { method: 'GET', path: '/health', summary: '存活探针', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'GET', path: '/api/status', summary: 'schema 版本与各表行数 (自检)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'GET', path: '/api/meta', summary: '契约描述 (本端点): 枚举/权重/阈值/默认值/能力依赖', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },

  { method: 'POST', path: '/api/context', summary: '注入组装, 前端每轮生成前的主入口', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 时无【相关细节】段, 仍返回画像与 FTS 记忆' },
  { method: 'POST', path: '/api/retrieve', summary: '三路召回原始结果 (调试用)', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 时响应无 chunkHits 字段' },

  { method: 'POST', path: '/api/extract', summary: '二阶六要素抽取 (人物/地点/时间点/事件/因果边)', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: 'LLM 未配置时 400' },
  { method: 'POST', path: '/api/extract-attributes', summary: '三阶属性观察抽取', needsLlm: true, needsEmbedding: true, degrade: 'error', degradeNote: 'LLM 或 embedding 未配置时 400' },
  { method: 'POST', path: '/api/extract-stances', summary: '立场抽取与演化', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: 'LLM 未配置时 400' },
  { method: 'POST', path: '/api/profiles-derive', summary: '画像重归纳 (观察块 -> 生效画像)', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: '目标人物无生效观察块时短路返回空, 不触达 LLM (此时即便未配 LLM 也返回 200)' },

  { method: 'POST', path: '/api/memories', summary: '手动写入一阶记忆', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'GET', path: '/api/memories', summary: '一阶记忆列表', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不传 chatId/characterId 时可见性退化为仅 scope=global' },
  { method: 'POST', path: '/api/chunks', summary: '手动写入观察块', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 时 embedded=false, 该块不参与向量召回' },
  { method: 'GET', path: '/api/chunks', summary: '观察块列表 (默认仅当前生效)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'POST', path: '/api/stances', summary: '手动写入立场', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'holder 与 target 同实体返回 400' },
  { method: 'GET', path: '/api/stances', summary: '立场列表 (overview=1 带对端名)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'POST', path: '/api/forget', summary: '遗忘衰减任务 (默认 dry-run)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'confirm 非 true 时只返回候选, 不改动数据' },
  { method: 'POST', path: '/api/forget/restore', summary: '恢复被软遗忘的条目', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'table ∈ memories|attribute_chunks|stances' },
];
