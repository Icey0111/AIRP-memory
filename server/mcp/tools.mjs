// MCP 工具清单: 语义(描述/枚举)从 domain/constants.js 派生, 不另行硬编码。
// 每个工具声明: 面向模型的 name/description/inputSchema + 到 HTTP 端点的映射。
// HTTP 语义(校验/默认值/降级)仍以服务端为准 —— 本层只是协议皮, 不复制语义。
import {
  ENDPOINTS, MEMORY_TYPES, MEMORY_SCOPES, OBSERVE_PIPELINE, OBSERVE_STEP_IDS,
} from '../src/domain/constants.js';

// 按 (method, path) 从唯一语义源取端点摘要; 取不到就报错, 防止清单与实现漂移。
function summaryOf(method, path) {
  const ep = ENDPOINTS.find((e) => e.method === method && e.path === path);
  if (!ep) throw new Error(`ENDPOINTS 缺少 ${method} ${path} —— 契约已漂移, 请先同步 constants.js`);
  return ep.summary;
}

const chatScopeFields = {
  chatId: { type: 'string', description: '聊天隔离域; 检索/写入都按它隔离' },
  characterId: { type: 'number', description: '角色隔离域 (scope=character 时必填)' },
};

const TYPE_VALUES = MEMORY_TYPES.map((t) => t.value);
const SCOPE_VALUES = MEMORY_SCOPES.map((s) => s.value);

export const TOOLS = [
  {
    name: 'memory_context',
    description: `${summaryOf('POST', '/api/context')}。生成回复前调用, 返回已组装的注入文本(画像/立场/实体/前情提要/时间线/待兑现/相关记忆/相关细节), 直接放进你的思考里。**characterId 传角色卡名, 否则【角色画像】段整段缺席**(画像按角色隔离)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前用户消息原文, 用于相关记忆召回' },
        chatId: { type: 'string', description: '聊天隔离域; 同一个会话务必用同一个值' },
        characterId: { type: 'string', description: '角色卡名(如 Seraphina); 不传就没有【角色画像】段' },
        topK: { type: 'number' }, tokenBudget: { type: 'number' }, digestMaxTokens: { type: 'number' },
        injectTables: { type: 'boolean' }, injectStances: { type: 'boolean' }, injectPending: { type: 'boolean' },
      },
      required: ['query', 'chatId', 'characterId'],
    },
    http: { method: 'POST', path: '/api/context' },
  },
  {
    name: 'memory_search',
    description: `${summaryOf('POST', '/api/retrieve')}。需要原始检索结果(记忆列表+观察块命中)而不是组装好的注入文本时用`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, topK: { type: 'number' },
        withChunks: { type: 'boolean' }, includeSummaries: { type: 'boolean' },
        ...chatScopeFields,
      },
      required: ['query'],
    },
    http: { method: 'POST', path: '/api/retrieve' },
  },
  {
    name: 'memory_observe',
    description: `${summaryOf('POST', '/api/observe')}。一段新剧情产生后调这一个就够了: 默认**只发一次 LLM 调用**就产出 ${OBSERVE_PIPELINE.map((s) => `${s.id}(${s.label})`).join(' / ')} 三层, 参数最多只需 text + chatId + sourceMessageIds。characterName 传角色卡原名、userName 传用户名(**同一会话必须始终用同一个称呼**, 换称呼会把"用户本人"裂成两个节点)`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待抽取的剧情文本 (带上下文的滑动窗口, 不要把单轮剜出来)' },
        chatId: { type: 'string' },
        sourceMessageIds: { type: 'array', items: { type: 'string' } },
        writeMemory: { type: 'boolean', description: '事件层是否同时落一条一阶记忆' },
        characterName: { type: 'string', description: '角色卡原名 (身份锚定)' },
        userName: { type: 'string', description: '用户名; 同一会话内固定不变 (identity anchor: 它决定谁是一等节点)' },
        steps: {
          type: 'array', items: { type: 'string', enum: [...OBSERVE_STEP_IDS] },
          description: '只补跑指定层 (会退化为分步并行); 缺省跑全部, 单次调用',
        },
      },
      required: ['chatId', 'text'],
    },
    http: { method: 'POST', path: '/api/observe' },
  },
  {
    name: 'memory_summarize',
    description: `${summaryOf('POST', '/api/summarize')}。会话结束或一段剧情告一段落时调用, 沉淀为摘要记忆(前情提要的来源)`,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        text: { type: 'string', description: '待压缩的剧情文本' },
        sourceMessageIds: { type: 'array', items: { type: 'string' } },
        characterId: { type: 'number' },
        inWorldTime: { type: 'string' }, keywords: { type: 'string' },
        importance: { type: 'number' }, maxChars: { type: 'number' },
        dedupe: { type: 'boolean', description: '同覆盖范围去重, 默认 true' },
      },
      required: ['chatId', 'text'],
    },
    http: { method: 'POST', path: '/api/summarize' },
  },
  {
    name: 'memory_write',
    description: `${summaryOf('POST', '/api/memories')}。type ∈ ${MEMORY_TYPES.map(t=>t.value).join('/')}; scope ∈ ${MEMORY_SCOPES.map(s=>s.value).join('/')}`,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: TYPE_VALUES },
        content: { type: 'string' },
        scope: { type: 'string', enum: SCOPE_VALUES },
        keywords: { type: 'string' }, importance: { type: 'number' },
        emotionalWeight: { type: 'number' },
        inWorldTime: { type: 'string' },
        ...chatScopeFields,
        sourceMessageIds: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'content'],
    },
    http: { method: 'POST', path: '/api/memories' },
  },
  {
    name: 'memory_write_chunk',
    description: `${summaryOf('POST', '/api/chunks')}。返回值 embedded=false 表示该块不参与向量召回`,
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', description: '如 person/location/item' },
        entityId: { type: 'number' },
        aspect: { type: 'string', description: '观察维度, 自由字符串' },
        content: { type: 'string' },
        importance: { type: 'number' },
        chatId: { type: 'string' }, memoryId: { type: 'number' },
        sourceMessageIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['entityType', 'entityId', 'content'],
    },
    http: { method: 'POST', path: '/api/chunks' },
  },
  {
    name: 'memory_write_stance',
    description: `${summaryOf('POST', '/api/stances')}`,
    inputSchema: {
      type: 'object',
      properties: {
        holderType: { type: 'string', description: 'person/org' },
        holderId: { type: 'number' },
        targetType: { type: 'string' }, targetId: { type: 'number' },
        stanceType: { type: 'string', description: '立场类型, 自由字符串(如 信任/戒备)' },
        intensity: { type: 'number', description: '0~1, 默认 0.5' },
        basis: { type: 'string' }, importance: { type: 'number' },
        chatId: { type: 'string' },
      },
      required: ['holderType', 'holderId', 'targetType', 'targetId', 'stanceType'],
    },
    http: { method: 'POST', path: '/api/stances' },
  },
  {
    name: 'memory_slots',
    description: `${summaryOf('GET', '/api/slots')}。看"谁对谁在哪一维度上的当前值及其迁移史"`,
    inputSchema: { type: 'object', properties: { ...chatScopeFields } },
    http: { method: 'GET', path: '/api/slots' },
  },
  {
    name: 'memory_list',
    description: `${summaryOf('GET', '/api/memories')}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...chatScopeFields,
        scope: { type: 'string', enum: SCOPE_VALUES },
        type: { type: 'string', enum: TYPE_VALUES },
        includeInactive: { type: 'boolean' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
    },
    http: { method: 'GET', path: '/api/memories' },
  },
  {
    name: 'memory_profiles_derive',
    description: `${summaryOf('POST', '/api/profiles-derive')}。观察块积累一批后对人物重归纳一次`,
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'number' }, characterId: { type: 'number' },
      },
    },
    http: { method: 'POST', path: '/api/profiles-derive' },
  },
  {
    name: 'memory_meta',
    description: `${summaryOf('GET', '/api/meta')}。拿不准枚举值/默认值/能力是否可用时先查它, 不要猜`,
    inputSchema: { type: 'object', properties: {} },
    http: { method: 'GET', path: '/api/meta' },
  },
];
