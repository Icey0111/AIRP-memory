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

  // ---- 注入 (每轮生成前) ----
  injectEnabled: true,
  // 下面两组取值是 SillyTavern 自身 API 的取值, 属宿主语义, 非后端语义
  injectPosition: 'in_prompt',   // in_prompt | in_chat
  injectRole: 'system',          // system | user | assistant
  injectDepth: 4,                // 仅 in_chat 生效
  retrievalTopK: 0,              // 0 = 用服务端默认
  retrievalTokenBudget: 0,       // 0 = 用服务端默认
  queryMessages: 1,
  queryMaxChars: 500,

  // ---- 写入 ----
  autoWriteEnabled: false,
  autoWriteEveryNMessages: 10,
  writeMessageCount: 10,
  writeMaxChars: 4000,
  writeSixElements: true,
  writeAttributes: true,
  writeStances: true,
  deriveProfile: true,

  debugLog: false,
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 保证 extension_settings[EXT_KEY] 存在, 并补齐新增字段 (老配置平滑升级) */
export function ensureSettings() {
  if (!extension_settings[EXT_KEY] || typeof extension_settings[EXT_KEY] !== 'object') {
    extension_settings[EXT_KEY] = clone(DEFAULT_SETTINGS);
  } else {
    extension_settings[EXT_KEY] = { ...clone(DEFAULT_SETTINGS), ...extension_settings[EXT_KEY] };
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
