// 扩展设置: 只保存"用户偏好"与"引导常量", 不保存任何后端语义
//
// 硬性约定 (与后端 docs/api.md §11、/api/meta 对应):
//   前端不得内置后端的枚举/标签、打分权重与公式、阈值、生效默认值、错误文案。
//   这些一律运行时从 GET /api/meta 取 (见 src/meta.js)。
//   本文件里唯一允许存在的"连接信息"是服务地址初值 —— 因为连不上服务时无从获取任何信息。
// 注意: 本文件在 src/ 下, 比扩展根深一层, 因此对酒馆模块的相对路径要比 index.js 多一层。
// 挂载点固定为 /scripts/extensions/third-party/<扩展目录>/ , 故:
//   /scripts/extensions.js  <- 4 层 ;  /script.js  <- 5 层
// (与磁盘安装位置无关: 无论是 data/<user>/extensions 还是 public/scripts/extensions/third-party)
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

export const EXT_NAME = 'tavern-memory';
export const EXT_KEY = 'tavernMemory';

// 唯一的引导常量: 连上服务前必须有个地址可试。用户可在面板里改。
export const BOOTSTRAP_BASE_URL = 'http://127.0.0.1:7780';

export const DEFAULT_SETTINGS = {
  enabled: true,
  baseUrl: BOOTSTRAP_BASE_URL,

  // 前端自身的网络超时 (非后端语义); 抽取类请求会按 /api/meta 下发的
  // capabilities.llm.timeoutMs 另行放宽
  requestTimeoutMs: 15000,

  // 服务端访问令牌 (server.token 非空时必填)。它只是"进门的钥匙"且可随时撤销,
  // 不是上游 API key —— 上游密钥永远只在服务端 (docs/frontend-v0.md 的既定方案)。
  // 手机/局域网访问场景必填, 本机回环访问留空即可。
  accessToken: '',

  // ---- 注入 (每轮生成前) ----
  injectEnabled: true,
  // 下面两组取值是 SillyTavern 自身 API 的取值, 属宿主语义, 非后端语义
  injectPosition: 'in_prompt',   // in_prompt | in_chat
  injectRole: 'system',          // system | user | assistant
  injectDepth: 4,                // 仅 in_chat 生效
  retrievalTopK: 0,              // 0 = 用服务端默认
  retrievalTokenBudget: 0,       // 0 = 用服务端默认
  // 「前情提要」(已总结摘要链) 的独立预算。它不参与相似度打分、也不占上面的检索预算,
  // 否则长对话里摘要会被"当前更像"的记忆挤掉, 而被隐藏的剧情就彻底没了。
  digestMaxTokens: 0,            // 0 = 用服务端默认
  queryMessages: 1,
  queryMaxChars: 500,

  // ---- 注入形态 (表格由服务端渲染, 这两个开关只决定用不用) ----
  // 关闭即走服务端的 bullet 回退路径, 信息不丢 (原文一字未删, 只是不再对齐成表)。
  // 表格的列名/行数上限/预算/阈值一律由 /api/meta 的 injectionTables 下发, 前端不复制。
  injectTables: true,            // 表格化注入 (画像/立场/关键实体/时间线/检索行)
  injectStancesSection: true,    // 「关系立场」常驻段 (角色之间的关系与态度)
  injectPendingSection: true,    // 未决命题段 (承诺/约定/威胁/悬而未决的线索)

  // ---- 写入 ----
  autoWriteEnabled: false,
  autoWriteEveryNMessages: 10,
  writeMessageCount: 10,
  writeMaxChars: 4000,
  writeSixElements: true,
  writeAttributes: true,
  writeStances: true,
  deriveProfile: true,

  // ---- 总结与压缩 (长对话) ----
  // 阈值类字段填 0 / -1 表示"用服务端建议值" (/api/meta 的 summaryPolicy):
  // 前端不复制一份阈值, 服务端调参后前端自动跟随。
  // 触发按**楼层数**计 (聊天记录条数, 用户与角色各占一层), 不按 token —— 理由见后端 SUMMARY_POLICY。
  summaryEnabled: false,
  summaryTriggerFloors: 0,        // 0 = 用服务端建议 (当前 10 层)
  summaryKeepRecentMessages: -1,  // -1 = 用服务端建议 (当前 6); 0 = 被总结的正文全部隐藏
  summaryHideAfter: true,         // 总结完成后隐藏被覆盖的正文

  debugLog: false,

  // 面板模块折叠状态 —— 由 UI 自身读写, 没有对应控件 (见下方的 NO_UI_KEYS)。
  // 默认收起不常用的三个, 打开面板时只露出"连接与能力"和"记忆注入"。
  uiCollapsed: { write: true, manual: true, diagnostics: true },
};

/** 由 UI 自身维护、没有面板控件的持久化键。静态检查据此豁免"每个键都必须有控件"。 */
export const NO_UI_KEYS = ['uiCollapsed'];

/**
 * 已废弃的键: 语义已变或改名 (如触发口径从估算 token 改成楼层数)。
 * 升级时清掉, 免得老配置里积一堆没有 UI、也没有代码读取的死键。
 */
export const DEPRECATED_SETTINGS = ['summaryTriggerTokens'];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 保证 extension_settings[EXT_KEY] 存在, 并补齐新增字段、清理废弃字段 (老配置平滑升级) */
export function ensureSettings() {
  if (!extension_settings[EXT_KEY] || typeof extension_settings[EXT_KEY] !== 'object') {
    extension_settings[EXT_KEY] = clone(DEFAULT_SETTINGS);
  } else {
    const merged = { ...clone(DEFAULT_SETTINGS), ...extension_settings[EXT_KEY] };
    for (const k of DEPRECATED_SETTINGS) delete merged[k];
    extension_settings[EXT_KEY] = merged;
  }
  return extension_settings[EXT_KEY];
}

export function getSettings() {
  return ensureSettings();
}

export function saveSettings() {
  try {
    saveSettingsDebounced();
  } catch (err) {
    console.error('[记忆系统] 保存设置失败', err);
  }
}

/** 只重置前端偏好; 不触碰服务端任何数据 */
export function resetSettings() {
  extension_settings[EXT_KEY] = clone(DEFAULT_SETTINGS);
  saveSettings();
  return extension_settings[EXT_KEY];
}
