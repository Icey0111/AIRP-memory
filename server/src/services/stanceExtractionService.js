// 立场抽取管线: 对话文本 -> LLM 立场抽取 -> 实体归并 -> 演化覆盖 -> 落库
// 演化口径: 同 (holder, target, stance_type) 的当前生效立场被新立场 supersedes;
//           不同 stance_type 并存 (信任能力与戒备动机可以同时成立)
import { findOrCreatePerson, findOrCreateOrg } from './entityService.js';
import { applyStance } from './stanceService.js';
import { parseJsonLoose } from './extractionService.js';

export const EXTRACT_SYSTEM = `你是角色扮演对话的立场抽取器。从对话中抽取人物/组织之间的相对立场。
立场是有向的: A对B 与 B对A 是两条独立记录, 不对称。只抽取对话中有依据的立场, 不要臆测。
严格输出 JSON, 不要输出任何其他文字:
{
  "stances": [
    {
      "holder_type": "person 或 org",
      "holder_name": "立场主体名称(用对话中的称呼)",
      "target_type": "person 或 org",
      "target_name": "立场对象名称",
      "stance_type": "立场类型, 如 信任/戒备/敌对/友好/爱慕/忠诚/敬畏/轻蔑, 不限于此",
      "intensity": 0.0到1.0,
      "displayed_type": "对外表现的立场类型, 表里如一则填 null",
      "is_public": true或false,
      "target_aware": true或false,
      "basis": "立场依据一句话(对话中的原因)",
      "importance": 0.0到1.0
    }
  ]
}
没有可抽取内容时输出 {"stances": []}`;

// JSON 解析统一用 parseJsonLoose (extractionService): 剥围栏 + 截取首尾大括号,
// LLM 在 JSON 前后加散文也能容错 —— 三个抽取器口径一致, 不再各写一份。
const parseJson = parseJsonLoose;

function resolveEntity(db, type, name) {
  if (type === 'person') return findOrCreatePerson(db, { name });
  if (type === 'org') return findOrCreateOrg(db, { name });
  return null;
}

export async function extractStances(db, { llm, chatId, text, sourceMessageIds = [] }) {
  if (!chatId) throw new Error('chatId 必填');
  const raw = await llm.chat({ system: EXTRACT_SYSTEM, user: text });
  const data = parseJson(raw);
  return persistStances(db, { chatId, stances: data.stances ?? [], sourceMessageIds });
}

/**
 * 立场的落库段 (与 LLM 调用分离)。
 * 与 persistObservations 同理: 让"一次 LLM 调用产出三个分区"的合并路径能复用落库,
 * 并顺便填上跨层锚点 (立场是被哪个事件触发的)。
 */
export function persistStances(db, { chatId, stances = [], sourceMessageIds = [], labels = null }) {
  if (!chatId) throw new Error('chatId 必填');
  const items = stances.filter((s) => s?.holder_name && s?.target_name && s?.stance_type);
  if (items.length === 0) return { stances: [], skipped: 0 };

  const results = [];
  let skipped = 0;
  const insertAll = db.transaction(() => {
    for (const s of items) {
      const holder = resolveEntity(db, s.holder_type, s.holder_name);
      const target = resolveEntity(db, s.target_type, s.target_name);
      // 不支持的实体类型 / 自指立场: 跳过计数
      if (!holder || !target) { skipped++; continue; }
      if (s.holder_type === s.target_type && holder.id === target.id) { skipped++; continue; }

      const anchor = anchorOf(s, labels);
      // 槽位写入 (V7): 槽位为空 -> 建立; 值相同 -> 确认(不新增行); 值不同 -> 迁移。
      // 迁移判定不再按 (holder,target,type) 找同类型旧行 —— 那是旧规则, 会让
      // "戒备 → 信任" 变成两条并存的立场, 而指针语义要求同槽位只有一个当前值。
      const applied = applyStance(db, {
        holderType: s.holder_type, holderId: holder.id,
        targetType: s.target_type, targetId: target.id,
        stanceType: s.stance_type,
        intensity: s.intensity ?? 0.5,
        displayedType: s.displayed_type ?? null,
        isPublic: s.is_public !== false,
        targetAware: s.target_aware !== false,
        basis: s.basis ?? '',
        dimension: s.dimension ?? undefined,
        chatId, sourceMessageIds,
        importance: s.importance ?? 0.5,
        validFromEventId: anchor,
      });
      results.push({
        id: applied.id,
        operation: applied.operation,
        holder: { type: s.holder_type, name: holder.name },
        target: { type: s.target_type, name: target.name },
        stanceType: s.stance_type,
        intensity: s.intensity ?? 0.5,
        supersedes: applied.from,
        fromValue: applied.fromValue,
        eventId: anchor,
      });
    }
  });
  insertAll();

  return { stances: results, skipped };
}

/** 立场声明的 event label → 事件 id (拿不到就留空, 绝不猜) */
function anchorOf(s, labels) {
  const label = String(s?.event ?? s?.event_label ?? '').trim();
  if (!label || !labels) return null;
  return labels[label] ?? null;
}
