// 二阶实体: find-or-create (别名归并) / 时间线 / 事件与因果边
import { now, clamp01 } from '../utils/text.js';
import { VERB_LAYER } from '../domain/constants.js';
import { ensureVocabulary, setVocabValue, parseTimeLabel } from './vocabularyService.js';

// ---------- 别名匹配: 主称呼相等 或 别名数组中包含 ----------
function findPersonByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM people
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(people.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

function mergeAliasList(existing, newAliases) {
  const cur = JSON.parse(existing.aliases || '[]');
  const merged = [...new Set([...cur, ...newAliases.filter((a) => a && a !== existing.name)])];
  return JSON.stringify(merged);
}

/**
 * find-or-create 人物 (别名归并)。
 *
 * ⚠️ `mergeAliases = false` 是 V6 的数据安全底线用法: **只有叙述者断言才能触发实体归并**
 *    (docs/verb-layer.md §5.3)。人物层说"那人是艾拉"若被当作归并处理, 会**不可逆地
 *    把两个实体并成一个** —— 这正是"撒谎/认错人"这类剧情的常见来源。
 *    故归属命题 (source_type='attributed') 解析人物时一律传 false: 只查不并, 找不到就新建,
 *    绝不把新别名挂到既有实体上。
 */
export function findOrCreatePerson(db, { name, aliases = [], personType = 'npc', mergeAliases = true }) {
  if (!name || !name.trim()) throw new Error('人名不能为空');
  name = name.trim();
  const existing = findPersonByNameOrAlias(db, name);

  // ---- main 唯一不变量 (§5.3 的边界情形, 2026-10-14 实测踩到) ----
  // "用户本人"在库里只能有一个节点。曾经的坏例子: userName 从"你"变"主角"就多出一个 main,
  // 立场与画像按节点裂成两套, 注入里出现同义两行 (塞拉菲娜→你 守护 / 塞拉菲娜→主角 保护)。
  //
  // 但**这里只做"不建第二个"**, 不做归并: 模型把谁标成 main 只是它的判断, 不是身份证据
  // (实测见过它把两个不同的人都标成 main —— 若按"后者并入前者"就会把一个真实角色并进另一个)。
  // 真正的归并只发生在**确定性证据**上: userName 命中, 走 ensureMainPerson()。
  if (personType === 'main') {
    const main = findMainPerson(db);
    if (main && (!existing || existing.id !== main.id)) personType = 'npc';
  }

  if (existing) {
    if (!mergeAliases) return { ...existing, existed: true };
    // 归并新别名
    const merged = mergeAliasList(existing, aliases);
    if (merged !== existing.aliases) {
      db.prepare('UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?').run(merged, now(), existing.id);
    }
    return { ...existing, aliases: merged, existed: true };
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO people (name, aliases, person_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(aliases.filter((a) => a && a !== name)), personType, ts, ts);
  return { id: Number(info.lastInsertRowid), name, aliases: JSON.stringify(aliases), person_type: personType, existed: false };
}

/**
 * 把某个称呼**确认为用户本人**(唯一 main)。只应由确定性证据调用 —— 目前只有一处:
 * 抽取时 userName 命中了模型输出里的人名 (applyIdentityAnchors)。
 *
 * 行为:
 *   · 库里已有 main → 若这次的名字落在另一个节点上, 把那个节点并进既有 main (复用其 id),
 *     并把名字记成别名 —— 于是换成"你/主角/爱丽丝"都落在同一个节点上;
 *   · 库里没有 main → 创建/提权这一个。
 */
export function ensureMainPerson(db, { name, aliases = [] } = {}) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('用户称呼不能为空');
  const ts = now();
  const main = findMainPerson(db);

  if (main) {
    const other = findPersonByNameOrAlias(db, n);
    if (other && other.id !== main.id) mergePersonIntoMain(db, { fromId: other.id, toId: main.id });
    const merged = mergeAliasList(db.prepare('SELECT * FROM people WHERE id = ?').get(main.id), [n, ...aliases]);
    db.prepare('UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?').run(merged, ts, main.id);
    return { ...db.prepare('SELECT * FROM people WHERE id = ?').get(main.id), aliases: merged, existed: true };
  }

  const existing = findPersonByNameOrAlias(db, n);
  if (existing) {
    const merged = mergeAliasList(existing, aliases);
    db.prepare("UPDATE people SET person_type = 'main', aliases = ?, updated_at = ? WHERE id = ?")
      .run(merged, ts, existing.id);
    return { ...existing, person_type: 'main', aliases: merged, existed: true };
  }
  return findOrCreatePerson(db, { name: n, aliases, personType: 'main' });
}

/** 当前唯一的 main 节点 (用户本人); 不存在返回 null */
export function findMainPerson(db) {
  return db.prepare(
    "SELECT * FROM people WHERE is_active = 1 AND person_type = 'main' ORDER BY id LIMIT 1"
  ).get() ?? null;
}

/**
 * 把一个人物节点并入 main (用户本人)。
 *
 * 用途有两处: ① 写入路径发现"又要建一个 main"时收口; ② 修既有数据的合并脚本。
 * 步骤刻意保持"只改引用、不删内容": 参与事件/立场/观察/引用桥全部改指 main,
 * 原节点软删 (is_active=0) —— 原文与历史都还在。
 * 冲突处理: event_participants 主键是 (event_id, person_id, role),
 * 同一事件同一角色两边都有时先删重复的那条, 否则 UPDATE 会撞主键。
 */
export function mergePersonIntoMain(db, { fromId, toId }) {
  if (!fromId || !toId || fromId === toId) throw new Error('合并需要两个不同的节点 id');
  const from = db.prepare('SELECT * FROM people WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT * FROM people WHERE id = ?').get(toId);
  if (!from || !to) throw new Error('节点不存在');
  const ts = now();
  const out = { from: from.name, into: to.name, repointed: {} };

  const run = (label, sql, ...args) => {
    const info = db.prepare(sql).run(...args);
    out.repointed[label] = (out.repointed[label] ?? 0) + info.changes;
  };

  // 1) 参与者: 先删会撞主键的重复行, 再改指
  run('event_participants_dedup', `
    DELETE FROM event_participants
    WHERE person_id = ?
      AND EXISTS (SELECT 1 FROM event_participants t
                  WHERE t.event_id = event_participants.event_id
                    AND t.person_id = ? AND t.role = event_participants.role)
  `, fromId, toId);
  run('event_participants', 'UPDATE event_participants SET person_id = ? WHERE person_id = ?', toId, fromId);

  // 2) 归属者 / 物品持有者
  run('events_source', 'UPDATE events SET source_person_id = ? WHERE source_person_id = ?', toId, fromId);
  run('items_owner', 'UPDATE items SET owner_person_id = ? WHERE owner_person_id = ?', toId, fromId);

  // 3) 立场 (多态: 只改 person 那一侧)
  run('stances_holder', "UPDATE stances SET holder_id = ? WHERE holder_id = ? AND holder_type = 'person'", toId, fromId);
  run('stances_target', "UPDATE stances SET target_id = ? WHERE target_id = ? AND target_type = 'person'", toId, fromId);

  // 4) 属性观察 / 引用桥 (引用桥主键含 entity_id, 同样先删重复)
  run('attribute_chunks', "UPDATE attribute_chunks SET entity_id = ? WHERE entity_type = 'person' AND entity_id = ?", toId, fromId);
  run('refs_dedup', `
    DELETE FROM memory_entity_refs
    WHERE entity_type = 'person' AND entity_id = ?
      AND EXISTS (SELECT 1 FROM memory_entity_refs t
                  WHERE t.memory_id = memory_entity_refs.memory_id
                    AND t.entity_type = 'person' AND t.entity_id = ?)
  `, fromId, toId);
  run('memory_refs', "UPDATE memory_entity_refs SET entity_id = ? WHERE entity_type = 'person' AND entity_id = ?", toId, fromId);

  // 5) 名字与别名并过去, 原节点软删 (历史保留)
  const merged = mergeAliasList(to, [from.name, ...JSON.parse(from.aliases || '[]')]);
  db.prepare('UPDATE people SET aliases = ?, person_type = ?, updated_at = ? WHERE id = ?')
    .run(merged, 'main', ts, toId);
  db.prepare('UPDATE people SET is_active = 0, updated_at = ? WHERE id = ?').run(ts, fromId);

  return out;
}

/**
 * 立场槽归位 (合并 main 之后必做)。
 *
 * 槽位 = (holder, target, dimension), 指针语义下**同槽位只应有一个当前值**。
 * 合并把两个 main 的立场并到同一槽位后, 会出现同槽位多条生效行 ——
 * 这里按"保留最新、其余入链"收口: 旧行 is_active=0, 新行的 supersedes_stance_id 指向前一行,
 * 于是注入里显示成 `守护 → 保护` (V7 的迁移显示), 而不是两行并存的重复。
 */
export function normalizeStanceSlots(db, { chatId = null } = {}) {
  const where = chatId ? 'AND chat_id = ?' : '';
  const args = chatId ? [chatId] : [];
  const slots = db.prepare(`
    SELECT holder_type, holder_id, target_type, target_id, IFNULL(stance_dimension, '总体') dim,
           COUNT(*) n, GROUP_CONCAT(id) ids
    FROM stances
    WHERE is_active = 1 ${where}
    GROUP BY holder_type, holder_id, target_type, target_id, dim
    HAVING n > 1
  `).all(...args);

  const fixed = [];
  const tx = db.transaction(() => {
    for (const s of slots) {
      const rows = db.prepare(`
        SELECT id FROM stances
        WHERE is_active = 1 AND holder_type = ? AND holder_id = ? AND target_type = ? AND target_id = ?
          AND IFNULL(stance_dimension, '总体') = ?
        ORDER BY id
      `).all(s.holder_type, s.holder_id, s.target_type, s.target_id, s.dim);
      for (let i = 0; i < rows.length - 1; i++) {
        const prev = i === 0 ? null : rows[i - 1].id;
        db.prepare('UPDATE stances SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), rows[i].id);
        if (prev !== null) db.prepare('UPDATE stances SET supersedes_stance_id = ? WHERE id = ?').run(prev, rows[i].id);
      }
      db.prepare('UPDATE stances SET supersedes_stance_id = ? WHERE id = ?').run(rows[rows.length - 2].id, rows[rows.length - 1].id);
      fixed.push({ slot: `${s.holder_type}#${s.holder_id}→${s.target_type}#${s.target_id}@${s.dim}`, kept: rows[rows.length - 1].id, retired: rows.slice(0, -1).map((r) => r.id) });
    }
  });
  tx();
  return fixed;
}

function findLocationByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM locations
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(locations.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

export function findOrCreateLocation(db, { name, parentName = null }) {
  if (!name || !name.trim()) return null;
  name = name.trim();
  const existing = findLocationByNameOrAlias(db, name);
  if (existing) return { ...existing, existed: true };

  let parentId = null;
  if (parentName) {
    const parent = findOrCreateLocation(db, { name: parentName });
    parentId = parent.id;
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO locations (name, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(name, parentId, ts, ts);
  return { id: Number(info.lastInsertRowid), name, parent_id: parentId, existed: false };
}

// ---------- 组织: 与人物同构的别名归并 ----------
function findOrgByNameOrAlias(db, name) {
  return db.prepare(`
    SELECT * FROM orgs
    WHERE is_active = 1
      AND (name = @name OR EXISTS (
        SELECT 1 FROM json_each(orgs.aliases) je WHERE je.value = @name
      ))
  `).get({ name });
}

export function findOrCreateOrg(db, { name, aliases = [], description = '' }) {
  if (!name || !name.trim()) throw new Error('组织名不能为空');
  name = name.trim();
  const existing = findOrgByNameOrAlias(db, name);
  if (existing) {
    const merged = mergeAliasList(existing, aliases);
    if (merged !== existing.aliases) {
      db.prepare('UPDATE orgs SET aliases = ?, updated_at = ? WHERE id = ?').run(merged, now(), existing.id);
    }
    return { ...existing, aliases: merged, existed: true };
  }
  const ts = now();
  const info = db.prepare(`
    INSERT INTO orgs (name, aliases, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(aliases.filter((a) => a && a !== name)), description, ts, ts);
  return { id: Number(info.lastInsertRowid), name, aliases: JSON.stringify(aliases), existed: false };
}

// ---------- 时间线: 按聊天隔离, seq 缺省顺延 ----------
/**
 * find-or-create 时间点 (V10: 抽象化 + 章节层级 + 落库前归一)。
 *
 * 三件 V10 才做的事, 每件都对应一个实测缺口:
 *   ① **时段指针**: 从 label 里抽出时段词 (夜/黄昏/清晨…) 接到时段元素上。
 *      时间点仍保留自己的身份 (UNIQUE(chat_id,label)) —— 归一**绝不**把两个夜晚并成一个时刻。
 *   ② **拆分整句标签**: "暮色中，临近戌时三刻落闸" 拆成 label="暮色中" + note="临近戌时三刻落闸"。
 *      ⚠️ 只在**不会撞车**时拆: 若本聊天已有同名时间点而它的 note 不同, 那两个是不同时刻,
 *      保持原样 (宁可标签长, 不可把两个时刻并成一个 —— 那会让时间轴丢刻度)。
 *   ③ **章节层级**: 抽取输出里的 `chapter` 以前被**静默丢弃** (本函数压根不接这个字段),
 *      于是 parent_id 实测 0/11 —— 章节从来没进过库。现在接上: 章节的 seq 跟随子节点,
 *      它不占时间轴刻度 (章节节点上没有实例, 不影响实例排序)。
 */
export function findOrCreateTimePoint(db, { chatId, label, seq = null, chapter = null, note = '' }) {
  if (!label || !String(label).trim()) return null;
  const full = String(label).trim();
  const parsed = parseTimeLabel(full);
  const head = parsed?.head ?? full;
  const qualifier = [parsed?.qualifier, String(note ?? '').trim()].filter(Boolean).join(' ');
  let useLabel = full; let useNote = String(note ?? '').trim();
  if (qualifier && head && head !== full && !parsed?.suffix) {
    const clash = db.prepare('SELECT * FROM time_points WHERE chat_id = ? AND label = ?').get(chatId, head);
    if (!clash || clash.note === qualifier) { useLabel = head; useNote = qualifier; }
  }

  const existing = db.prepare('SELECT * FROM time_points WHERE chat_id = ? AND label = ?').get(chatId, useLabel);
  if (existing) {
    if (parsed?.period && existing.period_id == null) {
      setVocabValue(db, 'time', { table: 'time_points', rowId: existing.id, value: parsed.period });
    }
    if (chapter && existing.parent_id == null) attachTimeChapter(db, chatId, existing, chapter);
    return { ...db.prepare('SELECT * FROM time_points WHERE id = ?').get(existing.id), existed: true };
  }

  if (seq == null) {
    seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM time_points WHERE chat_id = ?').get(chatId).m) + 1;
  }
  const info = db.prepare(`
    INSERT INTO time_points (chat_id, label, seq, note, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(chatId, useLabel, seq, useNote, now());
  const id = Number(info.lastInsertRowid);
  if (parsed?.period) setVocabValue(db, 'time', { table: 'time_points', rowId: id, value: parsed.period });
  if (chapter) attachTimeChapter(db, chatId, { id, seq }, chapter);
  return { ...db.prepare('SELECT * FROM time_points WHERE id = ?').get(id), existed: false };
}

/** 挂章节 (上级时间点): 不存在就建; 章节的 seq 跟随首个子节点 */
function attachTimeChapter(db, chatId, child, chapter) {
  const name = String(chapter).trim();
  if (!name || !child?.id) return null;
  let parent = db.prepare('SELECT * FROM time_points WHERE chat_id = ? AND label = ?').get(chatId, name);
  if (!parent) {
    const info = db.prepare(`
      INSERT INTO time_points (chat_id, label, seq, note, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(chatId, name, child.seq ?? 0, '章节', now());
    parent = { id: Number(info.lastInsertRowid) };
  }
  if (parent.id !== child.id) db.prepare('UPDATE time_points SET parent_id = ? WHERE id = ?').run(parent.id, child.id);
  return parent;
}

// ---------- 事件 ----------
/**
 * 轴③的缺省状态 (唯一口径, 抽取层与实体层共用): 归属命题一律未决;
 * 叙述者对未来的断言也是未决 (担保可信, 但尚未发生); 其余是既成事实。
 */
export function resolveStatus({ sourceType, tense }) {
  if (sourceType === 'attributed') return VERB_LAYER.defaults.attributedStatus;
  return tense === 'future'
    ? VERB_LAYER.defaults.narratorFutureStatus
    : VERB_LAYER.defaults.status;
}

export function findEventByTitle(db, chatId, title) {
  return db.prepare(
    'SELECT * FROM events WHERE chat_id = ? AND title = ? AND is_active = 1'
  ).get(chatId, title);
}

/**
 * 事件重述判等 (V9)。**只在实例带 label 时调用** —— 见调用处的说明。
 *
 * 两条分支各管一种"同一件事被再看见":
 *   ① `title` 相同 **且时间点相同** —— 描述性标题本身就是内容, 跨窗口可比。
 *      带上时间点是为了不吞掉"同一个动作在不同时间点真的又发生了一次"。
 *   ② `label` 相同 **且来源窗口相同** —— label("e1")是模型在一次输出内的临时编号,
 *      出了这个窗口就没有意义。曾经只按 (chat, title) 判等而 title 又被写成 label,
 *      于是第二段剧情里同样叫 e1 的实例被判"已存在"、整条被静默丢弃
 *      (2026-10-14 真实模型实测: 窗口 2 的事件落了 0 条)。
 *
 * 命中的含义是**重述**: 不新增行, 只 confirms+1 (与属性层/立场层对称)。
 */
export function findEventForRestatement(db, { chatId, title, timeId = null, label, scope }) {
  return db.prepare(`
    SELECT * FROM events
    WHERE chat_id = ? AND is_active = 1
      AND (
        (title = ? AND IFNULL(time_id, -1) = IFNULL(?, -1))
        OR (label IS NOT NULL AND label = ? AND source_message_ids = ?)
      )
    ORDER BY id LIMIT 1
  `).get(chatId, title, timeId, label, scope);
}

export function createEvent(db, {
  title, process = '', causeText = '', resultText = '',
  // ---- V9: 实例标签 (模型在一次输出内的临时编号, 供同窗口引用解析与重述判等) ----
  label = null, confirms = 0,
  timeId = null, locationId = null, chatId, memoryId = null,
  sourceMessageIds = [], importance = 0.5, emotionalWeight = 0,
  // ---- V6: 动词槽与命题三轴 ----
  verbType = '', verbSurface = '',
  polarity = VERB_LAYER.defaults.polarity,
  sourceType = VERB_LAYER.defaults.sourceType,
  sourcePersonId = null,
  attitude = null,
  tense = VERB_LAYER.defaults.tense,
  status = null,
  alignedInstanceId = null,
  parentInstanceId = null,
  parentRole = null,
}) {
  const ts = now();
  // 轴③的缺省由**这里**保证, 不依赖调用方记得传:
  //   归属命题默认未决 (它尚未与事实对齐), 叙述者对未来的断言同样未决。
  // 曾经缺省写死 'asserted' —— 于是 `createEvent({sourceType:'attributed'})` 会默默把
  // 一句"她说她要去"落成叙述者事实, 正是本项目最要防的"把意图写成事实"。
  const statusWord = status ?? resolveStatus({ sourceType, tense });
  // ---- V10: 落库前归一 (不靠 prompt 自觉) ----
  // 谓词/情态/从句/状态在这里被折进词表元素, 文本列只存**归一后的词**, 指针列指元素。
  // 对齐算法按谓词元素判等 (VERB_LAYER.alignment), 所以这一步是"真假判定能不能工作"的前提:
  // 从句说"去买"与事实"去"若各自是自由文本, 永远不同动词 => 永远不匹配 (实测 0 条判定)。
  const predicateEl = verbType ? ensureVocabulary(db, 'predicate', verbType) : null;
  const attitudeEl = attitude ? ensureVocabulary(db, 'attitude', attitude) : null;
  const clauseEl = parentRole ? ensureVocabulary(db, 'clause', parentRole) : null;
  const statusEl = statusWord ? ensureVocabulary(db, 'status', statusWord) : null;
  const info = db.prepare(`
    INSERT INTO events (title, process, cause_text, result_text, label, confirms,
      time_id, location_id, chat_id, memory_id, source_message_ids,
      importance, emotional_weight,
      verb_type, verb_surface, polarity, source_type, source_person_id, attitude,
      tense, status, aligned_instance_id, parent_instance_id, parent_role,
      predicate_id, attitude_id, clause_id, status_id,
      created_at, updated_at)
    VALUES (@title, @process, @causeText, @resultText, @label, @confirms,
      @timeId, @locationId, @chatId, @memoryId, @sourceMessageIds,
      @importance, @emotionalWeight,
      @verbType, @verbSurface, @polarity, @sourceType, @sourcePersonId, @attitude,
      @tense, @status, @alignedInstanceId, @parentInstanceId, @parentRole,
      @predicateId, @attitudeId, @clauseId, @statusId,
      @ts, @ts)
  `).run({
    title, process, causeText, resultText, label, confirms,
    timeId, locationId, chatId, memoryId,
    sourceMessageIds: JSON.stringify(sourceMessageIds),
    importance: clamp01(importance), emotionalWeight: clamp01(emotionalWeight, 0),
    verbType: predicateEl ? predicateEl.word : verbType, verbSurface,
    polarity, sourceType, sourcePersonId,
    attitude: attitudeEl ? attitudeEl.word : attitude,
    tense,
    status: statusEl ? statusEl.word : statusWord,
    alignedInstanceId, parentInstanceId,
    parentRole: clauseEl ? clauseEl.word : parentRole,
    predicateId: predicateEl?.id ?? null,
    attitudeId: attitudeEl?.id ?? null,
    clauseId: clauseEl?.id ?? null,
    statusId: statusEl?.id ?? null,
    ts,
  });
  return Number(info.lastInsertRowid);
}

export function addEventParticipant(db, { eventId, personId, role = '参与者' }) {
  // V10: 题元角色同样是词表元素 (agent→发起者 这类跨语言写法在落库前就归一到同一个节点),
  // 归一之后主键 (event_id, person_id, role) 会把"同一个人同一角色被写了两种写法"自然去重
  const el = ensureVocabulary(db, 'role', role);
  db.prepare(`
    INSERT OR IGNORE INTO event_participants (event_id, person_id, role, role_id) VALUES (?, ?, ?, ?)
  `).run(eventId, personId, el ? el.word : role, el?.id ?? null);
}

export function addEventLink(db, { fromId, toId, relation = 'caused' }) {
  if (fromId === toId) return false;
  const info = db.prepare(`
    INSERT OR IGNORE INTO event_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)
  `).run(fromId, toId, relation, now());
  return info.changes > 0;
}

export function addEntityRef(db, { memoryId, entityType, entityId }) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_entity_refs (memory_id, entity_type, entity_id) VALUES (?, ?, ?)
  `).run(memoryId, entityType, entityId);
}
