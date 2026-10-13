// 极简事件总线: 模块间单向通知, 避免模块互相 import 形成环
export function createBus() {
  const listeners = new Set();

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of [...listeners]) {
        try {
          fn(event);
        } catch (err) {
          console.error('[记忆系统] 订阅者异常', err);
        }
      }
    },
  };
}
