// 记忆系统 —— 酒馆 (SillyTavern) 前端扩展 · 入口
//
// 职责: 装配模块、挂载设置面板、绑定宿主事件。业务逻辑在 src/ 下按层拆分:
//   settings.js  前端偏好 + 引导常量 (唯一允许存在的本地配置)
//   api.js       HTTP 客户端 (不含任何后端语义)
//   meta.js      GET /api/meta 的本地镜像 —— 前端一切的语义来源
//   session.js   chatId / characterId 解析与对话原文收集
//   injector.js  生成前注入闭环 (GENERATION_AFTER_COMMANDS -> /api/context)
//   extractor.js 写入闭环 (四个抽取端点, 逐步静默降级)
//   ui.js        设置面板渲染与绑定
import { ensureSettings, getSettings } from './src/settings.js';
import { createApi } from './src/api.js';
import { createMetaStore } from './src/meta.js';
import { createInjector } from './src/injector.js';
import { createExtractor } from './src/extractor.js';
import { createSummarizer } from './src/summarizer.js';
import { createBus } from './src/bus.js';
import { createLog } from './src/log.js';
import { mountPanel } from './src/ui.js';
import { eventSource, event_types } from '../../../../script.js';

// 用 import.meta.url 定位模板, 与扩展安装目录名无关 (不依赖固定文件夹名)
const TEMPLATE_URL = new URL('./settings.html', import.meta.url);

jQuery(async () => {
  // 扩展热重载时避免重复挂载
  document.getElementById('tavern_memory_panel')?.remove();

  let html;
  try {
    const res = await fetch(TEMPLATE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText ?? ''}`.trim());
    html = await res.text();
  } catch (err) {
    console.error('[记忆系统] 设置面板模板载入失败:', TEMPLATE_URL.href, err);
    globalThis.toastr?.error?.('记忆系统: 设置面板载入失败, 详见控制台');
    return;
  }

  const holder = document.getElementById('extensions_settings');
  if (!holder) {
    console.error('[记忆系统] 未找到 #extensions_settings, 无法挂载设置面板');
    return;
  }
  holder.insertAdjacentHTML('beforeend', html);

  ensureSettings();

  const bus = createBus();
  const log = createLog(getSettings);
  const api = createApi(getSettings);
  const metaStore = createMetaStore(api, { bus, log });
  const injector = createInjector({ api, metaStore, getSettings, log, bus });
  const extractor = createExtractor({ api, metaStore, getSettings, log, bus });
  const summarizer = createSummarizer({ api, metaStore, getSettings, log, bus });

  mountPanel({ metaStore, injector, extractor, summarizer, log, bus });

  // 每轮生成前注入记忆 (契约未载入时自动跳过, 不做任何猜测)
  injector.bind();

  // 每收到一条角色消息: 写入侧计数 + 总结侧检查累计楼层是否达阈值
  eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    extractor.noteMessage();
    summarizer.noteMessage();
  });

  // 切换聊天: 撤下旧注入, 重置写入计数
  // (总结边界存在 chat_metadata 里, 随 chat 文件走, 切回来仍在, 无需重置)
  eventSource.on(event_types.CHAT_CHANGED, () => {
    injector.clear();
    extractor.reset();
    log.debug('聊天已切换, 注入已撤下, 自动写入计数已重置');
  });

  // 载入契约与运行时状态; 失败时面板会显示"未连接", 依赖项保持禁用
  await metaStore.refresh();

  log.info('已就绪');
});
