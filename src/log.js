// 日志: debug 受设置开关控制; warn/error 始终输出 (静默降级不等于静默失败)
export function createLog(getSettings) {
  const on = () => Boolean(getSettings()?.debugLog);
  return {
    debug: (...args) => { if (on()) console.log('[记忆系统]', ...args); },
    info: (...args) => console.log('[记忆系统]', ...args),
    warn: (...args) => console.warn('[记忆系统]', ...args),
    error: (...args) => console.error('[记忆系统]', ...args),
  };
}
