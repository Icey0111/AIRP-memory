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
 *
 * 注意用途边界: token 估算只用于 ①注入预算 ②总结的单批安全阀 (maxBatchTokens)。
 * 总结的**触发**不按 token, 而是按楼层数 —— 见 SUMMARY_POLICY。
 */
const CHARS_PER_TOKEN = 2;

export const TOKEN_ESTIMATION = {
  charsPerToken: CHARS_PER_TOKEN,
  formula: `估算 token ≈ ⌈字符数 / ${CHARS_PER_TOKEN}⌉`,
  description: '中英混合的保守估算, 不是真实分词; 用于注入预算与总结的单批安全阀, 不参与触发判断',
};

/**
 * 注入组装的段落填充顺序 (即实际拼接顺序)。
 * 前五段是"常驻"的: 不参与相似度打分, 也不会被检索预算挤掉 ——
 *   画像回答"角色是谁", 立场回答"谁对谁什么态度", 关键实体回答"反复出现的空间/人物是什么",
 *   前情提要回答"到现在为止发生了什么", 时间线回答"最近的事件按什么因果顺序发生"。
 * 后两段是"按需"的: 与当前轮 query 相关的记忆与细节, 按打分填预算。
 *
 * 常驻段各自走独立预算 (见 INJECTION_TABLES.budgets), 不与检索段互相挤占。
 */
export const CONTEXT_SECTIONS = [
  { order: 1, key: 'profile', label: '角色画像', description: '常驻; 类别/条目/内容 三列, 由观察块归纳的条目标 ※' },
  { order: 2, key: 'stances', label: '关系立场', description: '常驻; 当前聊天生效立场的有向边清单, 表露列承载二阶语义' },
  { order: 3, key: 'entities', label: '关键实体', description: '常驻限量; 人物/地点/物品/组织的规范速写与复现计数' },
  { order: 4, key: 'digest', label: '前情提要', description: '按楼层顺序拼接的摘要链, 常驻且不参与相似度打分' },
  { order: 5, key: 'timeline', label: '事件时间线', description: '常驻限量; 事件邻接视图, 因果边标注; 归属声称带来源口吻与定局标记' },
  { order: 6, key: 'pending', label: '待兑现', description: '常驻限量; 未决命题 (承诺/约定/威胁/线索), 独立预算, 空则不出段' },
  { order: 7, key: 'memories', label: '相关记忆', description: 'FTS 召回 (已排除摘要), 按打分顺序填预算' },
  { order: 8, key: 'chunks', label: '相关细节', description: '向量召回的观察块' },
];

// ============================================================
// 注入表格化 (docs/injection-tables.md)
// ============================================================
//
// 把注入文本从"平铺 bullet 行"升级为结构化表格: 行的组织方式变了, 通道不变
// (仍是常驻 + 检索 top-k), 结构层不动 (记忆数据早已在库中, 这是纯渲染层)。
//
// 跨端语义: 段落标题、行数上限、各段预算、立场显示规则都在这里定义一次,
// 经 /api/meta 下发; 前端只读 meta 并展示, 不另存一份, 也不出现列名/阈值字面量。
export const INJECTION_TABLES = {
  /** 总开关 (前端 injectTables 关掉即回到全量 bullet 路径, 无损可逆) */
  enabled: true,
  /** 输出形态: 常驻层对齐纯文本 (内容短且稳定, 对齐全开销值得); 检索层紧凑 markdown 行 (行多且每轮变化) */
  format: { resident: 'aligned', retrieved: 'markdown' },
  /**
   * 各段标题。后端渲染与前端展示同源, 避免"文档一种写法、代码另一种写法"。
   * stances 段是新内容注入 (立场原本完全不进 prompt), 可单独开关。
   */
  headers: {
    profile: '【角色画像】',
    stances: '【关系立场】',
    entities: '【关键实体】',
    timeline: '【事件时间线】',
    pending: '【待兑现】',
    memories: '【相关记忆】',
    chunks: '【相关细节】',
  },
  /** 规模防线: 防表格爆炸 (超限截行, 不截列) */
  limits: {
    profileRows: 40,
    stanceRows: 20,
    entityRows: 15,
    timelineRows: 12,
    pendingRows: 8,
    /** 单元格截断 (显示宽, 中文按 2 计); 0 = 不截断 */
    cellMaxWidth: 60,
  },
  /** 常驻段各自独立的 token 预算 (与检索 tokenBudget 分开, 互不挤占) */
  budgets: {
    profile: 600,
    stances: 400,
    entities: 400,
    timeline: 500,
    pending: 300,
  },
  /** 强度显示三档分界: < low 低, < high 中, 其余高 (避免 0.57 这种噪声数字) */
  intensityBands: { low: 0.34, high: 0.67 },
  intensityLabels: { low: '低', mid: '中', high: '高' },
  /**
   * 立场"表露"列的拼装规则 —— 一列承载三个二阶布尔维度, 不爆列数:
   *   displayed_type 非空 -> 表面{displayed_type}, 否则即本心
   *   is_public = 0       -> 前缀 隐秘·
   *   target_aware = 0    -> 后缀 ·对方不知
   */
  stanceDisplay: {
    hiddenPrefix: '隐秘·',
    disguisedPrefix: '表面',
    plainLabel: '即本心',
    unawareSuffix: '·对方不知',
    emptyBasis: '——',
    /** 演化链的展示 (V7 槽位模型): 值变过就显示 `戒备 → 信任`; 只显示不同的值, 重复的折叠掉 */
    showEvolution: true,
    evolutionSep: ' → ',
    /** 链上最多展示几个历史值 (防长链撑爆单元格) */
    evolutionMaxValues: 3,
  },
  /** 复现计数前缀 (L2 折叠链头专用: ×3 = 该行为被反复观察到 3 次) */
  recurrenceMark: '×',
  /**
   * 时间线行密度控制 (V6 §10.3): 动词实例的密度远高于旧版"事件"
   * (10 层剧情可能抽出 20+ 条), 不筛的话时间线会被琐碎实例淹没。
   * 保留条件 (任一满足): 有状态变化 / 在因果或条件边上 / 是归属声称 / importance ≥ 阈值。
   */
  timelineDensity: {
    minImportance: 0.45,
    rule: '有状态变化 或 在因果/条件边上 或 是归属声称 或 importance ≥ minImportance 才进时间线',
  },
  /**
   * 归属声称在时间线里的渲染 (§4.4 硬规则的落地): **必须带来源口吻**,
   * 并标出定局 (已证实 / 已被拆穿)。绝不能以叙述者口吻出场 ——
   * 否则模型会把角色的话当世界真相, 而这种错误比旧版吃书更隐蔽。
   */
  proposition: {
    /** 情态缺失时的兜底口吻 */
    fallbackAttitude: '声称',
    joiner: '：',
    noContent: '（内容未抽出）',
  },
  /** 【待兑现】段 (V6 §10.2): 未决命题清单, 独立预算, 空则不出段 */
  pendingSection: {
    header: '【待兑现】',
    /** 行模板: {actor} 持有者(可空) / {content} 内容 / {anchor} 时间锚(可空) */
    line: '- {actor}{content}（未决{anchor}）',
    anchorPrefix: ' · ',
    rationale:
      '承诺/约定/威胁/悬而未决的线索 —— 这批信息原先只存在于摘要的自由文本里, 无法核对、'
      + '无法标记、无法统计。结构化之后, 摘要层的压力卸掉一半。保新丢旧 (与楼上窗口相接的最近未决项最重要)。',
  },
  /**
   * 【事件时间线】的事件间因果标注 (§3.4)。
   * 每条 event_links 边只渲染一次 (渲染在"它是谁的成因/前承"那一行), 避免同一条边出现两遍:
   *   caused    入边 -> ← 起因   | led_to 出边 -> → 引出
   *   preceded  入边 -> ⇠ 前承   | contradicts 双向 -> ⇄ 矛盾
   */
  linkLabels: {
    caused: '← 起因',
    led_to: '→ 引出',
    preceded: '⇠ 前承',
    contradicts: '⇄ 矛盾',
    conditional: '⇢ 条件',
    alternative: '∨ 择一',
  },
  /** 时间线单元格式 (§3.4): 节点锚点 = label + seqMark + seq; 无时间节点的事件给未定时占位 */
  timeline: {
    seqMark: '#',
    /** 无 time_id 的事件显示为这个锚点 (占位, 保住对齐与分组) */
    untimedLabel: '未定时',
    /** 章节只在切换时随锚点出现一次, 形如 "第三章 / 第三夜, 暴雨 #7" */
    chapterSep: ' / ',
    /** 因果列多条边之间的分隔符 */
    linkSep: '; ',
    /** 事件注记来源优先级: 只写事件独有信息 (结果/经过), 不复述时间/人物/地点 (§4.6) */
    noteSources: ['result_text', 'process'],
    notePrefix: '〔',
    noteSuffix: '〕',
    /** 参与者角色等于该值时省略括号注记 (默认角色无需重复标注) */
    roleDefault: '参与者',
  },
  /** 【关键实体】表 (§4.2): 静态空间的"规范描述"住处, 排序依据 = 被事件引用的度数 */
  entities: {
    /** 收录的实体类型 (与 attribute_chunks.entity_type 的取值域一致) */
    types: ['person', 'location', 'item', 'org'],
    kindLabels: { person: '人物', location: '地点', item: '物品', org: '组织' },
    /** 各类型实体的表名与展示列 (只读查询用, 避免 SQL 里散落字面量) */
    sources: {
      person: { table: 'people', idCol: 'id' },
      location: { table: 'locations', idCol: 'id' },
      item: { table: 'items', idCol: 'id' },
      org: { table: 'orgs', idCol: 'id' },
    },
    /** 时间线窗口内的引用额外加权: score = (总度数 + 窗口内度数) × 观察块最高 importance */
    windowWeight: 2,
    /** 无别名 / 无速写时的占位符 */
    noAlias: '——',
    emptySketch: '——',
    /** 速写内容 (含链头观察) 之间用该符号连接 */
    sketchSep: '; ',
  },
  /**
   * 跨段去重 (L3): 画像表与立场表重叠的"态度"类条目以立场表为准 ——
   * 立场表带强度/表露/依据, 信息更全, 画像里再写一遍只是重复占 token。
   */
  dedupe: {
    profileStanceOverlap: true,
    /** 判定为"态度类"的画像类别 (自由字符串约定, 与 ASPECT_SUGGESTIONS.person 一致) */
    profileCategory: 'relationship',
  },
  /** 行内首次出现时的速写上限 (显示宽) —— 同一名实在一次注入中最多全量描述一次 */
  sketchMaxWidth: 12,
  /** 由观察块归纳 (非人工设定) 的画像条目行尾标记, 供人工核对 */
  derivedMark: '※',
  /** 表格渲染异常时的退化路径 (永远不断供) */
  fallbackOnError: 'bullets',
};

// ============================================================
// 动词层与命题层 (V6, 依据 docs/verb-layer.md)
// ============================================================
//
// 核心命题: **存原语与边, 其余都是视图**。
//   "事件"不是一个语言原语 (它是"谁—做了什么—对谁—何时何地—结果如何"的打包, 必然模糊),
//   动词/谓语才是 —— 题元语法: 谓语是枢纽, 施事/受事/时间/地点是它的边。
//
// 三根正交轴 (取代初版的 realis/irrealis 二元):
//   ① 时态定位 (只决定"到没到点")
//   ② 担保来源 (决定真值归谁 —— 撒谎因此才可表达)  ← 与①正交
//   ③ 对齐状态 (能被后来的事实改写)
// 另有极性 (参与对齐: ¬P 匹配到事实 P => 「被推翻」, 不是「兑现」)。
//
// 跨端可见的一切 (枚举/标签/阈值/默认值/公式) 只在本文件定义一次, 经 /api/meta 下发;
// 前端与 service 均不得另写一份。
export const VERB_LAYER = {
  /** 题元角色 (受约束建议值) —— 落在 event_participants.role */
  thematicRoles: [
    { value: '发起者', label: '发起者' },
    { value: '参与者', label: '参与者' },
    { value: '对象', label: '对象' },
    { value: '与事', label: '与事' },
    { value: '受害者', label: '受害者' },
    { value: '目击者', label: '目击者' },
    { value: '工具', label: '工具' },
    { value: '提及', label: '提及' },
  ],
  /**
   * 动词受控词表 (建议值, 非强制)。归一用 verb_type, 原文永远保留在 verb_surface。
   * 与实体层同一原则: 自由字符串入库 + 建议值做输入提示, 不因词表之外就丢弃。
   */
  verbSuggestions: [
    '说', '问', '答', '看', '听', '摸', '去', '来', '给予', '取', '转交',
    '承诺', '威胁', '救助', '伤害', '隐瞒', '发现', '决定', '离开', '战斗',
  ],
  polarities: [
    { value: '+', label: '肯定' },
    { value: '-', label: '否定', description: '参与对齐: ¬P 匹配到事实 P 判「被推翻」' },
  ],
  /**
   * 轴②担保来源。**这是不可靠叙述的落点**: 叙述者断言进事实层;
   * 归属给某人的命题真值挂在持有者身上 (可能撒谎、可能记错)。
   */
  sources: [
    {
      value: 'narrator', label: '叙述者断言', description: '进事实层 (v_facts); 是唯一可触发实体归并的来源',
    },
    {
      value: 'attributed', label: '归属给某人',
      description: '进命题层 (v_propositions); 必须带持有者与情态; 不得触发实体归并',
    },
  ],
  /** 情态 (仅 attributed): 持有者对该命题的态度 */
  attitudes: [
    { value: '说', label: '说' },
    { value: '认为', label: '认为' },
    { value: '相信', label: '相信' },
    { value: '希望', label: '希望' },
    { value: '怀疑', label: '怀疑' },
    { value: '假装', label: '假装' },
    { value: '不知', label: '不知' },
  ],
  /** 轴①时态定位: 只决定"到没到点", 与来源正交 */
  tenses: [
    { value: 'past', label: '过去' },
    { value: 'now', label: '现在' },
    { value: 'future', label: '未来' },
  ],
  /**
   * 轴③对齐状态。对齐 = 命题与事实的匹配, 是**同一操作的双向形式**:
   *   未来命题到点匹配事实 -> realized; 被引述的过去命题被确认 -> realized(证实);
   *   被否证 -> refuted(撒谎/记错); 极性冲突 -> refuted(被推翻);
   *   条件未成立 -> inactive; 择一未选中 -> voided。
   */
  statuses: [
    { value: 'asserted', label: '叙述者事实', short: '事实', description: 'narrator 的缺省状态' },
    { value: 'pending', label: '未决', short: '未决', description: 'attributed 的缺省状态, 等待与事实对齐' },
    { value: 'realized', label: '已兑现 / 已证实', short: '已证实' },
    { value: 'failed', label: '已落空', short: '已落空' },
    { value: 'inactive', label: '未激活（条件未成立）', short: '未激活' },
    { value: 'refuted', label: '被推翻（极性冲突 / 被否证）', short: '已被拆穿' },
    { value: 'voided', label: '已作废（择一未选中）', short: '已作废' },
  ],
  /** 嵌套引述的角色 (parent_role): 深度上限见 alignment.maxNestingDepth */
  parentRoles: [
    { value: 'comp', label: '命题宾语（从句）' },
    { value: 'cond', label: '条件前件' },
    { value: 'alt', label: '择一候选' },
  ],
  /**
   * event_links.relation 全集。
   * ⚠️ 必须与 db/schema.sql 与迁移里的 CHECK 词表一致 —— test/verbs.smoke.js 有断言钉死。
   */
  linkRelations: ['caused', 'led_to', 'preceded', 'contradicts', 'conditional', 'alternative'],
  /** 写入缺省值 */
  defaults: {
    sourceType: 'narrator',
    /** 归属命题的缺省状态: 未决 (等待对齐) */
    attributedStatus: 'pending',
    /** 叙述者对未来的断言: 也是未决 (叙述者担保, 但尚未发生) */
    narratorFutureStatus: 'pending',
    polarity: '+',
    tense: 'past',
    status: 'asserted',
  },
  /** 对齐口径 (V6-3 实现; 这里是跨端可见的契约描述) */
  alignment: {
    threshold: 0.8,
    /** 打分权重: 动词必须相同(硬条件), 其余是加权项 */
    weights: {
      verb: 0.6,
      thematicOverlap: 0.3,
      location: 0.1,
    },
    formula: 'score = 0.6 × 动词匹配 + 0.3 × 题元重叠率 + 0.1 × 地点相同; 动词不同直接不匹配',
    rule: '匹配 = 同动词 + 题元重叠达阈值 + 到点; 极性相同 -> 已兑现/已证实, 极性相反 -> 被推翻',
    principle: '宁缺勿错: 不确定就保持未对齐 —— 误判兑现比漏判更有害 (模型会把没发生的事当真)',
    maxNestingDepth: 2,
    /**
     * 「到点」口径: 未来命题所在时间节点之后又出现了新的时间节点 => 那个"明天"已经过去。
     * 无时间锚的命题不判到点 (宁可留着未决)。
     */
    dueRule: '未来命题的 time_id 之后存在更晚的时间节点 => 已到点; 无时间锚不判',
    /** 条件命题的后果何时转为「未激活」: 条件被判定落空/被推翻/作废时 */
    inactiveRule: '条件前件落空/被推翻/作废 => 后果转未激活',
    /** 择一: 同一父实例下的 alt 候选中有一个兑现, 其余作废 */
    alternativeRule: '同一父实例下的 alt 候选中一个已兑现 => 其余作废',
  },
  /**
   * 注入分组口径 (由 /api/meta 下发, 前端与渲染层同源):
   *   timelineStatuses  进【事件时间线】—— 已发生的事实、已证实的声称、已被拆穿的声称
   *                     (被拆穿的谎话是人物证据, 值得模型看见)
   *   pendingStatuses   进【待兑现】—— 未决命题 (承诺/约定/威胁/悬而未决的线索)
   *   unrealizedStatuses 两边都不进 —— 它们表示"没发生" (落空/未激活/作废)
   *
   * 为什么未决的不进时间线: 时间线读作"发生过什么", 塞进未发生的会诱导模型当成事实;
   * 而未决项自身有专门的前瞻段落, 不必也不该在时间线里出现两次。
   */
  timelineStatuses: ['asserted', 'realized', 'refuted'],
  pendingStatuses: ['pending'],
  unrealizedStatuses: ['failed', 'inactive', 'voided'],
};

// ============================================================
// 槽位模型 (V7, 依据 docs/verb-layer.md §16)
// ============================================================
//
// 用户提出的核心断言: **状态迁移 (否→是 / A→B) 不是再造新文本, 而是挪动指针**。
// 推论 (用户补充的前提): **元素先于指针** —— 指针只能指向网中已存在的元素,
//   所以取值本身也必须是元素 (value_nodes), 而不是随手写的自由字符串;
//   否则"信任/信赖/信服"是三个不同文本 = 没指向同一个元素。
//
// 三种结构操作 (必须区分, 否则"新增"会被塞成假迁移):
//   建立 ∅→A (唯一写文本处) / 迁移 A→B (只挪指针) / 撤销 A→∅ (指针置空)
export const SLOT_MODEL = {
  /** 立场槽位的缺省维度。同槽位的值变化 = 迁移; 需要并存时用不同维度声明 */
  stanceDefaultDimension: '总体',
  /** 槽位: (holder, target, dimension); 属性槽位: (entity, aspect) */
  slotDefs: [
    { kind: 'stance', label: '立场槽', key: '(持有者, 对象, 维度)', note: '值 = stance_type' },
    {
      kind: 'attribute',
      label: '属性槽',
      key: '(实体, 维度)',
      note: '值 = 观察内容; 重述不新增行 (confirms+1), 措辞变了才迁移并留档相似度 (V8)',
    },
  ],
  /** 结构操作类型 (跨端可见: 面板与注入都会提到"迁移/确认") */
  operations: [
    { value: 'create', label: '建立', description: '槽位从无到有, 长文本在此写一次' },
    { value: 'migrate', label: '迁移', description: '值变了, 指针移动 (只记短标签)' },
    { value: 'confirm', label: '确认', description: '值没变, 只是再次被观察到 (计数 +1, 不新增行)' },
    { value: 'revoke', label: '撤销', description: '指针置空; 文本仍在, 可恢复' },
  ],
  /**
   * V8 重述判定: 属性槽里"同一个值被再次观察到"与"值真的变了"必须分开。
   *
   * 判据是**确定性的**(规范化后文本判等), 不是相似度阈值 —— 这一点是实测校准的结果:
   * mock embedding 下"仅标点差异"=0.85、"末尾加一句"=0.81、"中间加修饰"=0.89,
   * 与真正的一次更新落在同一区间, 阈值会卡在噪声里无法使用。
   * 于是分工为: **规范化判等 = 是不是重述; 相似度 = 是不是同一个槽位 (建不建链)**。
   */
  restatement: {
    rule: 'normalize-equal',
    normalize: 'NFKC 归一 → 转小写 → 去掉所有空白与标点, 只留字母/数字/汉字',
    semantics: '规范化后完全相同 => 重述 (不新增行, confirms+1); 只要措辞变了 => 更新 (写新行 + 记 supersede_similarity)',
    whyNotThreshold: '相似度分不开"换个标点"和"改了内容", 所以只用来决定是否建立覆盖链',
    keepDetail: '措辞变化可能带新细节, 宁可多存一行也不丢细节',
  },
  /** 取值元素的 kind 取值域 (value_nodes.kind) */
  valueKinds: [
    { value: 'stance_type', label: '立场类型', description: '立场槽的取值域' },
    { value: 'aspect', label: '属性维度', description: '属性槽的维度取值域' },
  ],
  /** 迁移记录从 supersedes 链**无损推导** (链头 = 当前指针值, 链身 = 迁移序列) */
  derivation: {
    currentFrom: '链头 (未被任何行 supersedes 的生效行)',
    transitionsFrom: '沿 supersedes 指针回溯, 相邻两行的值不同 => 迁移, 相同 => 确认',
    principle: '不新增表, 不复制文本 —— 迁移记录是视图',
  },
};

// ============================================================
// 阈值 (防吃书)
// ============================================================

export const THRESHOLDS = {
  /**
   * 同实体同维度, 新观察与旧块余弦 >= 此值 => 判定为同一属性槽位的更新, 建立 supersedes 覆盖链。
   *
   * ⚠️ 它**不判"是否为重述"** —— 那是规范化文本判等的事 (见 SLOT_MODEL.restatement)。
   * 两个门槛各管一段: 相似度决定"是不是同一条属性" (建不建链),
   * 规范化判等决定"值动没动" (要不要写新行)。
   */
  supersedeSimilarity: 0.85,
  /** 相似度度量 */
  similarityMetric: 'cosine',
};

// ============================================================
// 总结策略 (摘要记忆层): 何时压缩、压到多长
// ============================================================

/**
 * 长对话压缩策略。前端据此累计楼层并决定何时触发一次总结,
 * 因此这些阈值属于"跨端语义" —— 只在后端定义一次, 由 /api/meta 下发,
 * 前端不另存一份 (前端设置里的同名字段为 0 / -1 时表示"用这里的值")。
 *
 * 触发量纲是**楼层**而不是 token (关键选择, 理由见下方 rationale):
 *   楼层 = 聊天记录条数, 用户消息与角色消息各占一层, 也就是酒馆里"第几楼"。
 *   按 token 触发看似精确, 实则把"什么时候会总结"交给了用户的语速 ——
 *   话密的人三五层就触发一次(摘要碎), 话少的人几十层才触发一次(摘要跨度大),
 *   同样的默认值在不同人的聊天里表现完全不同, 用户无法预期。
 *   楼层数是用户能直接看到的量, 粒度可控、可预期。
 */
export const SUMMARY_POLICY = {
  /** 未总结区间的**楼层数**达到该值 => 触发一次总结 */
  triggerFloors: 10,
  /**
   * 单批送进 LLM 的输入上限 (token, 安全阀)。
   * 注意: 它**不参与触发判断** —— 触发只看楼层数。
   * 保留它的理由是楼层数与文本量并不成正比: 10 层可能是 1k, 也可能是 30k token。
   * 超出的楼层留到下一批, 保证喂给 LLM 的 prompt 不撑爆上下文。
   */
  maxBatchTokens: 12000,
  /** 摘要正文长度上限 (字符)。后端据此约束 LLM 输出, 超长会截断 */
  maxSummaryChars: 800,
  /** 摘要记忆的默认 importance。比普通事件高: 一条摘要代表一整段的整体 */
  defaultImportance: 0.6,
  /**
   * 总结后建议保留的最近楼层数 (不隐藏)。0 = 被总结的正文全部隐藏。
   * 保留几层的理由: 模型对上下文末尾最敏感, 逐字保留最近的对话能显著降低答非所问。
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
      + '按默认 maxSummaryChars=800 与 triggerFloors=10 的口径, 2000 token 约容纳 5 条摘要、'
      + '约覆盖 50 层原文。',
  },
  /** 触发方式标识 (目前只有一种; 前端据此选择累计逻辑) */
  trigger: 'floor-count',

  /** 为什么取这个量级。前端原样展示, 免得两端各说一套 */
  rationale:
    '按楼层计数而不是按估算 token: 每个人的单条输出长度差异极大, 固定 token 阈值等于把'
    + '"什么时候总结"交给了用户的语速 —— 话密的人三五层就触发一次, 摘要碎成流水账; '
    + '话少的人几十层才触发一次, 摘要跨度大到跨场混淆。同样一个默认值, 在不同人的聊天里'
    + '表现完全不同, 用户也无法预期下一次总结何时到来。'
    + '楼层数是用户能直接看到的量 (聊天记录第几层), 默认 10 层大致是"一小场戏"的粒度, '
    + '粒度可控、可预期, 也便于用户自己估摸。'
    + '代价是单批输入长度不定, 由 maxBatchTokens 兜底: 超出的楼层留到下一批, 不会撑爆上下文。',

  /** 按对话节奏给的选择建议 (前端原样展示, 不做二次加工) */
  presets: [
    { floors: 5, note: '快节奏短句对话; 摘要更贴当前, 但条数也更多' },
    { floors: 10, note: '默认量级, 大致一小场戏' },
    { floors: 20, note: '慢节奏长文; 摘要更少, 但每段跨度更大' },
    { floors: 40, note: '不建议再大: 单批输入容易过长, 摘要本身也会失焦' },
  ],

  /** 触发楼层数的合法区间 (前端输入框钳制用; 也是后端接受的边界) */
  limits: { min: 2, max: 200 },
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
  stanceEvolution: '同槽位 (持有者, 对象, 维度) 的新立场覆盖旧立场 —— 值变了就是一次迁移, 值相同只累加确认计数; 需要并存的两种态度面用不同维度声明。',
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

  { method: 'POST', path: '/api/context', summary: '注入组装, 前端每轮生成前的主入口', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 或 embedding 服务故障时无【相关细节】段 (故障原因经 chunkError 字段上报), 仍返回画像与 FTS 记忆' },
  { method: 'POST', path: '/api/retrieve', summary: '三路召回原始结果 (调试用)', needsLlm: false, needsEmbedding: false, degrade: 'silent', degradeNote: '未配 embedding 时响应无 chunkHits 字段; embedding 服务故障时返回 chunkError 而非 400' },

  { method: 'POST', path: '/api/extract', summary: '述谓实例抽取 (谁—动词—谁 + 来源/时态/极性, 含人物/地点/时间点/因果边)', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: 'LLM 未配置时 400' },
  { method: 'POST', path: '/api/extract-attributes', summary: '三阶属性观察抽取', needsLlm: true, needsEmbedding: true, degrade: 'error', degradeNote: 'LLM 或 embedding 未配置时 400' },
  { method: 'POST', path: '/api/extract-stances', summary: '立场抽取与演化', needsLlm: true, needsEmbedding: false, degrade: 'error', degradeNote: 'LLM 未配置时 400' },
  { method: 'GET', path: '/api/slots', summary: '槽位与状态迁移 (当前指针值 + 迁移序列, 从 supersedes 链推导)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },

  { method: 'GET', path: '/api/config', summary: '模型配置打码视图 (密钥只回显 ••••+末4位, 不可还原)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力' },
  { method: 'POST', path: '/api/config', summary: '保存模型配置 (深合并写盘 + 热重建客户端, 无需重启; 只接受 llm/embedding 两节)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '不依赖任何外部能力; 密钥留空或回传打码值 = 保持不变' },
  { method: 'GET', path: '/api/config/models', summary: '拉取供应商模型列表 (服务端持钥代理 GET /models; ?kind=llm|embedding)', needsLlm: false, needsEmbedding: false, degrade: 'error', degradeNote: '对应能力未配置 baseUrl/apiKey 时 400' },
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
