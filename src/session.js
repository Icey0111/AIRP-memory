// 会话上下文: chatId / characterId 解析 + 对话原文收集
//
// 与后端约定的 id 口径 (见 docs/api.md §10):
//   chatId      = 酒馆 chat 文件名 (去扩展名), 即 SillyTavern 的 context.chatId
//   characterId = 角色卡名字符串 (对应后端 character_profiles.character_id)
//   注意: 后端 attribute_chunks.entity_id / stances.holder_id 是 people/orgs 表的整数 id,
//        两者不可混用 —— 本模块只产出上面两种字符串型 id。
// 注意: 本文件在 src/ 下, 比扩展根深一层, 对酒馆模块的相对路径要比 index.js 多一层。
// 挂载点固定为 /scripts/extensions/third-party/<扩展目录>/ , 故 /scripts/extensions.js 是 4 层。
import { getContext } from '../../../../extensions.js';

// 酒馆主脚本模块 —— 用动态 import 取, 而不是静态 import 一堆导出名。
// 理由: 不同酒馆版本导出的命令执行器名字不一样 (executeSlashCommandsWithOptions /
// executeSlashCommands), 静态导入不存在的名字会让整个模块加载失败, 扩展直接起不来。
// 路径层数同上方注释: src/ 比扩展根深一层, /script.js 是 5 层。
const SCRIPT_MODULE_URL = new URL('../../../../../script.js', import.meta.url).href;

let scriptModule;
let scriptModuleTried = false;

/** 取酒馆主脚本模块 (拿不到就返回 null, 调用方走兜底) */
export async function importScriptModule() {
  if (scriptModuleTried) return scriptModule;
  scriptModuleTried = true;
  try {
    scriptModule = await import(SCRIPT_MODULE_URL);
  } catch (err) {
    scriptModule = null;
    console.warn('[记忆系统] 无法载入酒馆主脚本模块, 将退化为直接操作 chat:', err?.message ?? err);
  }
  return scriptModule;
}

export function getChatId() {
  const ctx = getContext();
  return ctx?.chatId
    || (typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null)
    || 'default';
}

export function getCharacterId() {
  const ctx = getContext();
  return ctx?.name2
    || ctx?.characterName
    || (ctx?.characters && ctx?.characterId !== undefined ? ctx.characters[ctx.characterId]?.name : null)
    || 'unknown';
}

export function isGroupChat() {
  const ctx = getContext();
  return Boolean(ctx?.groupId) || Array.isArray(ctx?.groups) && ctx?.groupId !== undefined;
}

function usableMessage(m) {
  if (!m || m.is_system) return null;
  const text = typeof m.mes === 'string' ? m.mes.trim() : '';
  return text ? text : null;
}

/**
 * 收集最近若干条对话原文 (供抽取端点使用)。
 * 从最新往回取, 超出 maxChars 即停 —— 保证拿到的是上下文最近的片段。
 * @returns {{ text: string, sourceMessageIds: string[], messageCount: number }}
 */
export function collectMessages({ count = 10, maxChars = 4000 } = {}) {
  const ctx = getContext();
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  const name1 = ctx?.name1 || '用户';
  const name2 = ctx?.name2 || '角色';

  const picked = [];
  let used = 0;

  for (let i = chat.length - 1; i >= 0 && picked.length < count; i--) {
    const text = usableMessage(chat[i]);
    if (text === null) continue;
    const speaker = chat[i].is_user ? name1 : (chat[i].name || name2);
    const line = `${speaker}: ${text}`;
    if (picked.length > 0 && used + line.length > maxChars) break;
    picked.push({ index: i, line });
    used += line.length;
  }

  picked.reverse();
  return {
    text: picked.map((p) => p.line).join('\n'),
    // 楼层号 (0 起), 供后端溯源与前端对账
    sourceMessageIds: picked.map((p) => String(p.index)),
    messageCount: picked.length,
  };
}

/** 生成检索 query: 取最近 count 条消息, 截断到 maxChars */
export function buildQuery({ count = 1, maxChars = 500 } = {}) {
  const ctx = getContext();
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  const picked = [];

  for (let i = chat.length - 1; i >= 0 && picked.length < count; i--) {
    const text = usableMessage(chat[i]);
    if (text !== null) picked.push(text);
  }

  picked.reverse();
  return picked.join('\n').slice(0, maxChars);
}

// ---------------------------------------------------------------
// 楼层区间 (供"上次总结边界 -> 现在"的增量压缩使用)
// ---------------------------------------------------------------

/** 最后一个楼层的索引; 无楼层返回 -1 */
export function lastMessageIndex() {
  const chat = getContext()?.chat;
  return Array.isArray(chat) && chat.length ? chat.length - 1 : -1;
}

/**
 * 按固定楼层区间收集对话原文 (与 collectMessages 的"取最近 N 条"不同)。
 * 跳过已隐藏 (is_system) 与空消息 —— 注意隐藏与"不算入累计"是同一件事:
 * 已总结并被隐藏的正文不会再被计入 token 累计, 否则会反复触发总结。
 *
 * maxChars > 0 时是**严格前缀**: 一旦某条装不下就停, 不跳过它去装更靠后的消息。
 * 这条约束是为"已总结边界"服务的 —— 只有文本与楼层是连续前缀,
 * 边界才能精确落在一个真实被总结过的楼层上 (见 lastIncluded)。
 *
 * @param {{fromIndex?:number, toIndex?:number, maxChars?:number}} [opts]
 *        toIndex = -1 表示取到最后; maxChars = 0 表示不限长
 * @returns {{text:string, sourceMessageIds:string[], messageCount:number,
 *            charCount:number, from:number, to:number, lastIncluded:number|null}}
 *          lastIncluded = 实际进入 text 的最后一个楼层; 无内容时为 null
 */
export function collectRange({ fromIndex = 0, toIndex = -1, maxChars = 0 } = {}) {
  const ctx = getContext();
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  const name1 = ctx?.name1 || '用户';
  const name2 = ctx?.name2 || '角色';

  const last = chat.length - 1;
  const from = Math.max(0, Math.min(fromIndex, last));
  const to = toIndex < 0 ? last : Math.min(toIndex, last);

  const picked = [];
  let charCount = 0;

  for (let i = from; i <= to; i++) {
    const text = usableMessage(chat[i]);
    if (text === null) continue;
    const speaker = chat[i].is_user ? name1 : (chat[i].name || name2);
    const line = `${speaker}: ${text}`;
    // 严格前缀: 装不下就停, 不跳过去装更靠后的消息。
    // 否则"已总结区间"无法精确对应楼层, 边界会推进到没被总结的楼层上,
    // 那些楼层的正文会被连带隐藏而永久丢失 (它们既没进摘要, 也不在 prompt 里了)。
    if (maxChars > 0 && charCount + line.length > maxChars) break;
    charCount += line.length;
    picked.push({ index: i, line });
  }

  return {
    text: picked.map((p) => p.line).join('\n'),
    sourceMessageIds: picked.map((p) => String(p.index)),
    messageCount: picked.length,
    charCount,
    from,
    to,
    lastIncluded: picked.length ? picked[picked.length - 1].index : null,
  };
}

/**
 * 隐藏 / 取消隐藏楼层区间, 使这些正文不再进入 prompt。
 *
 * 实现口径: 酒馆的 /hide 与 /unhide 本质就是对 chat[i].is_system 置位, 而本模块的
 * usableMessage() 同样跳过 is_system —— 所以隐藏之后这些楼层既不会进 prompt,
 * 也不会再被抽取或计入累计楼层, 两端天然一致, 不需要额外的排除逻辑。
 *
 * 优先调用酒馆原生命令 (它会自己刷新 UI 上的 ghost 标记); 命令不可用时退回直接置位,
 * 并尽力通知 UI 刷新。失败不抛错。
 *
 * @returns {Promise<{ok:boolean, via?:'slash'|'direct', from?:number, to?:number, count?:number, reason?:string}>}
 */
export async function setHidden(fromIndex, toIndex, hidden = true) {
  const ctx = getContext();
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  if (!chat.length) return { ok: false, reason: '当前没有对话' };

  const last = chat.length - 1;
  const from = Math.max(0, Math.min(fromIndex, toIndex, last));
  const to = Math.min(Math.max(fromIndex, toIndex), last);
  if (to < from) return { ok: false, reason: '楼层区间无效' };

  const range = from === to ? String(from) : `${from}-${to}`;
  const mod = await importScriptModule();
  const run = mod?.executeSlashCommandsWithOptions ?? mod?.executeSlashCommands;

  if (typeof run === 'function') {
    try {
      await run(`/${hidden ? 'hide' : 'unhide'} ${range}`);
      return { ok: true, via: 'slash', from, to, count: to - from + 1 };
    } catch (err) {
      console.warn('[记忆系统] 隐藏命令执行失败, 退化为直接置位:', err?.message ?? err);
    }
  }

  let count = 0;
  for (let i = from; i <= to; i++) {
    if (!chat[i]) continue;
    chat[i].is_system = hidden;
    count += 1;
    // 尽力让 UI 重绘该楼层 (事件不存在就算了, 不影响隐藏本身生效)
    const et = mod?.event_types;
    if (mod?.eventSource && et?.MESSAGE_UPDATED !== undefined) {
      mod.eventSource.emit(et.MESSAGE_UPDATED, i);
    }
  }
  return { ok: true, via: 'direct', from, to, count };
}

// ---------------------------------------------------------------
// per-chat 状态 (总结边界等)
// ---------------------------------------------------------------

const STATE_KEY = 'tavernMemory';

// chatMetadata 不可用时的退化存储 (仅本次会话有效)
let memoryState = null;

/**
 * 读当前聊天的扩展状态。优先用酒馆的 chat_metadata —— 它随 chat 文件落盘,
 * 换页/切聊天/重启都不会丢; 拿不到时退化为内存对象 (面板会提示"仅本次会话有效")。
 */
export function getChatState() {
  const md = getContext()?.chatMetadata;
  if (md && typeof md === 'object') {
    const s = md[STATE_KEY];
    return (s && typeof s === 'object') ? s : {};
  }
  return memoryState ?? {};
}

/** 合并写入当前聊天的扩展状态, 并尽力落盘 */
export async function setChatState(patch) {
  const md = getContext()?.chatMetadata;
  const next = { ...getChatState(), ...patch };
  if (md && typeof md === 'object') {
    md[STATE_KEY] = next;
    const mod = await importScriptModule();
    try {
      await mod?.saveMetadata?.();
    } catch {
      // 没有 saveMetadata 也不致命: 酒馆下次保存聊天时会带上 chat_metadata
    }
  } else {
    memoryState = next;
  }
  return next;
}

/** 清空当前聊天的扩展状态 (不动聊天本身) */
export async function clearChatState() {
  const md = getContext()?.chatMetadata;
  memoryState = null;
  if (md && typeof md === 'object') {
    delete md[STATE_KEY];
    const mod = await importScriptModule();
    try {
      await mod?.saveMetadata?.();
    } catch { /* 同上 */ }
  }
  return {};
}

