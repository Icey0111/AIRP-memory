// 前端契约校验: 用前端的 api.js + meta.js 直接对接真实服务, 验证"前端只吃契约"
//
// api.js / meta.js 不依赖任何 SillyTavern API, 因此可以在 Node 里直接跑。
// 校验点:
//   1) 契约能载入, 且前端需要的字段都在
//   2) canCall() 完全跟随服务端声明的 needsLlm/needsEmbedding (前端不自作判断)
//   3) label() 能拿到服务端下发的中文标签 (前端没有自建映射表)
//   4) 抽取类请求的超时由服务端下发的 llm.timeoutMs 推算 (前端不写死)
//   5) 服务不可达时 meta 置空, canCall 一律不可用 —— 不退回硬编码
//
// 用法: 先启动服务 (cd server && npm start), 再 node check-contract.mjs [baseUrl]
import { createApi } from './src/api.js';
import { createMetaStore } from './src/meta.js';

const baseUrl = process.argv[2] || 'http://127.0.0.1:7780';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const api = createApi(() => ({ baseUrl, requestTimeoutMs: 15000 }));
const store = createMetaStore(api, { bus: null, log: { debug() {}, info() {}, warn() {}, error: console.error } });

// ---------- 服务可达性 ----------
let reachable = true;
try {
  await api.health();
} catch (err) {
  reachable = false;
  console.log(`\n服务不可达 (${baseUrl}): ${err.message}`);
  console.log('先启动服务再跑本检查: cd server && npm start\n');
}

if (reachable) {
  // ============================================================
  // 1) 契约载入
  // ============================================================
  console.log('\n--- 契约载入 ---');
  const snap = await store.refresh();
  check('契约已载入', snap.loaded === true, snap.lastError ?? '');
  check('schema 版本与最高支持版本都在', Number.isFinite(snap.meta?.schemaVersion) && Number.isFinite(snap.meta?.latestSupported));
  check('前端所需的顶层字段齐备',
    ['capabilities', 'defaults', 'enums', 'scoring', 'thresholds', 'rules', 'endpoints', 'limits', 'cors']
      .every((k) => snap.meta?.[k] !== undefined),
    JSON.stringify(Object.keys(snap.meta ?? {})));

  const m = snap.meta;

  // ============================================================
  // 2) canCall 完全跟随服务端声明
  // ============================================================
  console.log('\n--- canCall 跟随服务端声明 ---');
  const ctxGate = store.canCall('POST', '/api/context');
  check('POST /api/context 声明不依赖 LLM/embedding -> 可用', ctxGate.ok === true, ctxGate.reason ?? '');

  const llmCap = store.capability('llm');
  const extractGate = store.canCall('POST', '/api/extract');
  check('POST /api/extract 的可用性等于 llm.available',
    extractGate.ok === (llmCap.available === true),
    `canCall.ok=${extractGate.ok} llm.available=${llmCap.available}`);
  if (!llmCap.available) {
    check('LLM 不可用时, 被拦截的端点给出原因 (不是静默 false)',
      typeof extractGate.reason === 'string' && extractGate.reason.length > 0, String(extractGate.reason));
  }

  const embCap = store.capability('embedding');
  const attrGate = store.canCall('POST', '/api/extract-attributes');
  check('POST /api/extract-attributes 同时受 llm 与 embedding 约束',
    attrGate.ok === (llmCap.available === true && embCap.available === true),
    `canCall.ok=${attrGate.ok} llm=${llmCap.available} embed=${embCap.available}`);

  check('未知端点一律判为不可用 (不猜)',
    store.canCall('POST', '/api/nonexistent').ok === false);

  // 通用: 对 meta 声明的每个端点, canCall 结果必须与声明一致
  let consistent = 0;
  for (const ep of m.endpoints) {
    const gate = store.canCall(ep.method, ep.path);
    const expect = (!ep.needsLlm || llmCap.available) && (!ep.needsEmbedding || embCap.available);
    if (gate.ok === expect) consistent++;
    else console.error(`     不一致: ${ep.method} ${ep.path} gate=${gate.ok} expect=${expect}`);
  }
  check(`全部 ${m.endpoints.length} 个端点的 canCall 与声明一致`, consistent === m.endpoints.length);

  // ============================================================
  // 3) 标签来自服务端
  // ============================================================
  console.log('\n--- 标签来自服务端 ---');
  const typeOpts = store.getEnumOptions('memoryType');
  check('memoryType 选项非空', Array.isArray(typeOpts) && typeOpts.length > 0);
  check('label() 取到服务端下发的中文标签 (前端无自建映射)',
    store.label('memoryType', 'fact') === (typeOpts.find((o) => o.value === 'fact')?.label ?? 'fact'),
    `fact -> ${store.label('memoryType', 'fact')}`);
  check('未知值原样返回而不抛错', store.label('memoryType', '__nope__') === '__nope__');
  check('forgetTable 带 hasAccess 标记',
    (store.getEnumOptions('forgetTable') ?? []).every((o) => typeof o.hasAccess === 'boolean'));
  check('每个枚举项都有 label',
    m.endpoints.length > 0 && ['memoryType', 'memoryScope', 'forgetTable', 'chunkableEntityType']
      .every((n) => (store.getEnumOptions(n) ?? []).every((o) => typeof o.label === 'string' && o.label.length > 0)));

  // ============================================================
  // 4) 超时由服务端推算
  // ============================================================
  console.log('\n--- 超时推算 ---');
  const t = store.llmRequestTimeoutMs();
  check('抽取请求超时 = 服务端 llm.timeoutMs + 余量', t === llmCap.timeoutMs + 5000, `得到 ${t}, llm.timeoutMs=${llmCap.timeoutMs}`);

  // ============================================================
  // 5) 打分口径与规则为服务端原文
  // ============================================================
  console.log('\n--- 打分口径 ---');
  check('检索打分公式为字符串原文', typeof store.getScoring()?.retrieval?.formula === 'string'
    && store.getScoring().retrieval.formula.length > 0);
  check('权重和为 1', Math.abs(Object.values(store.getScoring().retrieval.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check('supersede 阈值为数字', typeof store.getThresholds()?.supersedeSimilarity === 'number');
  check('可见性规则文案非空', typeof store.getRules()?.visibility === 'string' && store.getRules().visibility.length > 0);

  // ============================================================
  // 4b) 总结策略: 触发量纲必须是楼层数 (前端据此累计, 不能是 token)
  // ============================================================
  console.log('\n--- 总结触发量纲 ---');
  const sp = store.summaryPolicy();
  check('summaryPolicy 已下发', sp !== null && typeof sp === 'object');
  check('触发方式标识为 floor-count (前端据此选择累计逻辑)',
    sp?.trigger === 'floor-count', String(sp?.trigger));
  check('触发楼层数是正数且落在服务端自述的合法区间内',
    Number.isFinite(sp?.triggerFloors)
    && sp.triggerFloors >= sp.limits.min && sp.triggerFloors <= sp.limits.max,
    `triggerFloors=${sp?.triggerFloors} limits=${JSON.stringify(sp?.limits)}`);
  check('契约里不再下发 token 触发阈值 (量纲已统一为楼层)',
    sp?.triggerTokens === undefined && sp?.minTokens === undefined);
  check('defaults.summary.triggerFloors 与策略同源',
    store.getDefaults().summary.triggerFloors === sp.triggerFloors,
    `defaults=${store.getDefaults().summary.triggerFloors} policy=${sp.triggerFloors}`);
  check('节奏预设每项都带 floors 与 note (面板原样展示)',
    (sp?.presets ?? []).length > 0
    && sp.presets.every((p) => Number.isFinite(p.floors) && typeof p.note === 'string'));
  check('单批安全阀仍下发 (不参与触发判断, 但前端要展示)',
    Number.isFinite(sp?.maxBatchTokens) && sp.maxBatchTokens > 0);

  // ============================================================
  // 6) 实际调用: /api/context 可用且形状符合预期
  // ============================================================
  console.log('\n--- 实测 /api/context ---');
  try {
    const ctx = await api.context({ query: '测试查询', chatId: 'contract-check', characterId: '测试角色' });
    check('/api/context 返回 ok', ctx.ok === true);
    check('/api/context 含注入文本与统计字段',
      typeof ctx.text === 'string' && typeof ctx.usedTokens === 'number'
      && typeof ctx.tokenBudget === 'number' && typeof ctx.hitCount === 'number'
      && typeof ctx.chunkHitCount === 'number',
      JSON.stringify(ctx).slice(0, 200));
    check('/api/context 的 tokenBudget 等于契约下发的默认值',
      ctx.tokenBudget === store.getDefaults().retrieval.tokenBudget,
      `响应 ${ctx.tokenBudget} vs 契约 ${store.getDefaults().retrieval.tokenBudget}`);
  } catch (err) {
    check('/api/context 可调用', false, err.message);
  }
}

// ============================================================
// 7) 服务不可达: 不退回硬编码
// ============================================================
console.log('\n--- 不可达时的降级 ---');
const deadApi = createApi(() => ({ baseUrl: 'http://127.0.0.1:59999', requestTimeoutMs: 2000 }));
const deadStore = createMetaStore(deadApi, { bus: null, log: { debug() {}, info() {}, warn() {}, error() {} } });
const deadSnap = await deadStore.refresh();
check('不可达时 meta 置空', deadSnap.loaded === false && deadStore.getMeta() === null);
check('不可达时记录错误原因', typeof deadSnap.lastError === 'string' && deadSnap.lastError.length > 0, String(deadSnap.lastError));
check('不可达时枚举返回 null (前端无从硬编码)',
  deadStore.getEnumOptions('memoryType') === null && deadStore.getDefaults() === null);
check('不可达时 canCall 一律不可用',
  deadStore.canCall('POST', '/api/context').ok === false && deadStore.canCall('GET', '/health').ok === false);
check('不可达时超时推算返回 null (交由 api 层默认值)',
  deadStore.llmRequestTimeoutMs() === null);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
