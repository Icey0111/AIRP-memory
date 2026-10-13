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
