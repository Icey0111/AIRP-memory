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

/**
 * 摘要记忆的类型值。摘要层多处引用 (注入时从相似度召回中排除、前情提要筛选、遗忘保护),
 * 定义一次以免各写各的字面量。必须与 MEMORY_TYPES 里的 'summary' 一致。
 */
export const SUMMARY_MEMORY_TYPE = 'summary';

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

/**
 * token 估算口径: 前端展示预算时需知道后端怎么算的。
 * charsPerToken 是参数而非写死在文案里 —— 前端按同一个系数估算, 两端口径才不会漂移。
 * (改成参数后, 调这个系数只需改一处, 文案会自动跟着变。)
 */
const CHARS_PER_TOKEN = 2;

export const TOKEN_ESTIMATION = {
  charsPerToken: CHARS_PER_TOKEN,
  formula: `估算 token ≈ ⌈字符数 / ${CHARS_PER_TOKEN}⌉`,
  description: '中英混合的保守估算, 不是真实分词; 前端累计与后端预算使用同一口径',
};

/**
 * 注入组装的段落填充顺序。
 * 前两段是"常驻"的: 不参与相似度打分, 也不会被检索预算挤掉 ——
 *   画像回答"角色是谁", 前情提要回答"到现在为止发生了什么"。
 * 后两段是"按需"的: 与当前轮 query 相关的记忆与细节, 按打分填预算。
 */
export const CONTEXT_SECTIONS = [
  { order: 1, key: 'profile', label: '角色画像', description: '常驻保底, 预算外优先保证' },
  { order: 2, key: 'digest', label: '前情提要', description: '按楼层顺序拼接的摘要链, 常驻且不参与相似度打分' },
  { order: 3, key: 'memories', label: '相关记忆', description: 'FTS 召回 (已排除摘要), 按打分顺序填预算' },
  { order: 4, key: 'chunks', label: '相关细节', description: '向量召回的观察块' },
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
// 总结策略 (摘要记忆层): 何时压缩、压到多长
// ============================================================

/**
 * 长对话压缩策略。前端据此累计 token 并决定何时触发一次总结,
 * 因此这些阈值属于"跨端语义" —— 只在后端定义一次, 由 /api/meta 下发,
 * 前端不另存一份 (前端设置里的同名字段为 0 / -1 时表示"用这里的值")。
 *
 * 量纲统一走 TOKEN_ESTIMATION: token ≈ ⌈字符数 / charsPerToken⌉。
 * 前端累计与后端预算共用同一系数, 才不会出现"前端以为还早、后端已经爆预算"。
 */
export const SUMMARY_POLICY = {
  /** 未总结区间的累计估算 token 达到该值 => 触发一次总结 */
  triggerTokens: 6000,
  /** 低于该值不触发。碎片摘要信息密度低, 还会白占注入预算 */
  minTokens: 1500,
  /** 单批总结的输入上限: 超出部分留到下一批, 保证喂给 LLM 的 prompt 不撑爆上下文 */
  maxBatchTokens: 12000,
  /** 摘要正文长度上限 (字符)。后端据此约束 LLM 输出, 超长会截断 */
  maxSummaryChars: 800,
  /** 摘要记忆的默认 importance。比普通事件高: 一条摘要代表一整段的整体 */
  defaultImportance: 0.6,
  /**
   * 总结后建议保留的最近消息条数 (不隐藏)。0 = 被总结的正文全部隐藏。
   * 保留几条的理由: 模型对上下文末尾最敏感, 逐字保留最近几轮能显著降低答非所问。
   */
  keepRecentMessages: 6,

  /**
   * 【前情提要】段: 已生成的摘要如何随对话一起送进 prompt。
   *
   * 为什么摘要不能走相似度召回 (关键设计):
   *   摘要覆盖的正文已被 /hide 移出 prompt, 摘要是那段剧情唯一的载体。
   *   若摘要仍按 FTS 取 top-k, 当前轮关键词不命中就会整条不进 prompt,
   *   被隐藏的区间在模型眼里就成了空洞 —— 而且这是系统性偏向漏:
   *   摘要长、关键词稀疏, 在 bm25 里天然吃亏, 而相关性恰好占打分权重的 0.6。
   *   因此摘要改为"按楼层顺序拼接、必然在场"的独立段落, 不参与打分。
   */
  digest: {
    /** 该段的 token 预算 (独立于检索 tokenBudget, 不与相关记忆互相挤占) */
    maxTokens: 2000,
    /** 只取本聊天的摘要 (scope='chat' 且 chat_id 匹配), 不跨聊天拼链 */
    scope: 'chat',
    /** 面板输入的合法区间 (0 在协议里表示"用服务端默认值") */
    limits: { min: 1, max: 8000 },
    rationale:
      '与可见窗口相接的最近摘要最关键 (决定"刚才发生了什么"), 所以预算不足时优先保新、丢最早; '
      + '早期剧情里的稳定设定通常已沉淀到角色画像与 fact 记忆, 不会因为丢掉最早一条摘要而消失。'
      + '按默认 maxSummaryChars=800 与 triggerTokens=6000 的口径, 2000 token 约容纳 5 条摘要、'
      + '约覆盖 150 层原文。',
  },
  /** 触发方式标识 (目前只有一种; 前端据此选择累计逻辑) */
  trigger: 'estimated-tokens',

  /** 为什么取这个量级。前端原样展示, 免得两端各说一套 */
  rationale:
    '按本系统的估算口径, 典型中文角色扮演单条约 150-300 token, 一轮往返约 300-600 token; '
    + '6000 token 大致是 20 条消息 / 10 轮往返, 接近"一小场戏"的粒度。'
    + '此时单次总结的输入 (约 6000) 叠加系统提示与角色卡 (约 2000-4000) 与输出余量, '
    + '在 16k 上下文的模型上仍安全; 8k 模型应下调, 32k 以上可上调。',

  /** 按模型上下文规模给的选择建议 (前端原样展示, 不做二次加工) */
  presets: [
    { contextSize: 8192, triggerTokens: 3000, note: '固定开销占比大, 宁小勿大' },
    { contextSize: 16384, triggerTokens: 6000, note: '默认量级, 兼顾粒度与安全' },
    { contextSize: 32768, triggerTokens: 10000, note: '可按"一场戏"为单位总结' },
    { contextSize: 131072, triggerTokens: 12000, note: '不建议再加: 再长摘要本身会失焦' },
  ],

  /** 阈值合法区间 (前端输入框钳制用; 也是后端接受的边界) */
  limits: { min: 1000, max: 20000 },
};

/**
 * 【前情提要】段的文本形状。服务端据此组装, 前端只展示不解析。
 * 每条摘要行首带它覆盖的楼层区间, 让模型知道这段剧情发生在多早之前。
 * 改这里即同时改变两端呈现, 不会出现"文档一种写法、代码另一种写法"。
 */
export const DIGEST_FORMAT = {
  header: '【前情提要】',
  /** 每行的模板; {from}/{to} 为该摘要覆盖的楼层区间, {content} 为摘要正文 */
  line: '[{from}-{to}] {content}',
  description: '按楼层顺序拼接的摘要链; 行首 [起-止] 为覆盖的楼层区间',
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
  summaryDigest:
    "摘要 (type='summary') 不参与相似度召回, 只以【前情提要】段按楼层顺序常驻注入; "
    + '它覆盖的正文已由 /hide 移出 prompt, 所以摘要必须必然在场 —— 否则那段剧情在模型眼里会变成空洞。',
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
  { method: 'POST', path: '/api/summarize', summary: '长对话压缩: 一段剧情 -> 一条摘要记忆', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: 'LLM 未配置时 400' },

  { method: 'POST', path: '/api/memories', summary: '手动写入一阶记忆', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'GET', path: '/api/memories', summary: '一阶记忆列表', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不传 chatId/characterId 时可见性退化为仅 scope=global' },
  { method: 'POST', path: '/api/chunks', summary: '手动写入观察块', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 时 embedded=false, 该块不参与向量召回' },
  { method: 'GET', path: '/api/chunks', summary: '观察块列表 (默认仅当前生效)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'POST', path: '/api/stances', summary: '手动写入立场', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'holder 与 target 同实体返回 400' },
  { method: 'GET', path: '/api/stances', summary: '立场列表 (overview=1 带对端名)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'POST', path: '/api/forget', summary: '遗忘衰减任务 (默认 dry-run)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'confirm 非 true 时只返回候选, 不改动数据' },
  { method: 'POST', path: '/api/forget/restore', summary: '恢复被软遗忘的条目', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: 'table ∈ memories|attribute_chunks|stances' },
];
