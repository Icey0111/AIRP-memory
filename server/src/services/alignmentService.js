// 对齐: 命题 ⇄ 事实 (V6, docs/verb-layer.md §6)
//
// 核心洞见: 对齐是**同一个操作的双向形式** ——
//   未来命题到点匹配事实        -> 已兑现 (realized)
//   被引述的过去命题被确认       -> 已证实 (realized)
//   被引述的过去命题被否证       -> 撒谎 / 记错 (refuted)
//   命题 ¬P 匹配到事实 P        -> 被推翻 (refuted)
//   条件未成立                  -> 未激活 (inactive)
//   择一候选中别的兑现了         -> 作废 (voided)
// 一套机制同时覆盖"承诺未兑现"与"谎话被拆穿"两种叙事张力。
//
// 设计红线 (宁缺勿错): 不确定就保持未对齐。**误判兑现比漏判更有害** ——
// 模型会把没发生的事当真, 而这种错误静默。
import { now } from '../utils/text.js';
import { VERB_LAYER } from '../domain/constants.js';

const A = VERB_LAYER.alignment;
const W = A.weights;

/** 只有这两类状态算"已发生的事" (对齐的事实端候选) */
const FACT_STATUSES = VERB_LAYER.timelineStatuses;

/** 未决集合 = 所有 status='pending' 的实例 (含叙述者对未来的断言) */
const PENDING_SQL = "SELECT * FROM events WHERE status = 'pending'";

function participantsOf(db, instanceId) {
  const rows = db.prepare('SELECT person_id FROM event_participants WHERE event_id = ?').all(instanceId);
  return new Set(rows.map((r) => r.person_id));
}

/**
 * 该实例是否还有未决的命题宾语(从句)。
 *
 * 有从句的实例**自己不参与事实匹配** —— 因为待兑现的是从句的内容, 而从句是独立实例,
 * 由它去对齐。否则"说"这类低特异性动词会仅凭"动词+参与者"就泛匹配到任何一次交谈,
 * 把命题过早判成已兑现 (实测踩到, 违反"宁缺勿错")。
 */
function hasPendingComp(db, instanceId) {
  return db.prepare(`
    SELECT 1 FROM events
    WHERE parent_instance_id = ? AND parent_role = 'comp' AND status = 'pending'
    LIMIT 1
  `).get(instanceId) != null;
}

/**
 * 命题与事实的匹配打分。
 * 动词不同直接不匹配 (硬条件); 命题没有题元填充者时不匹配 —— 无法判定就宁可不判。
 * @returns {{score:number, overlap:number, polaritySame:boolean, sameLocation:boolean}|null}
 */
export function matchScore(db, prop, fact) {
  if (!prop.verb_type || prop.verb_type !== fact.verb_type) return null;
  const pp = participantsOf(db, prop.id);
  if (pp.size === 0) return null;
  const fp = participantsOf(db, fact.id);
  let hit = 0;
  for (const id of pp) if (fp.has(id)) hit++;
  const overlap = hit / pp.size;
  const sameLocation = prop.location_id != null && prop.location_id === fact.location_id;
  const score = W.verb + W.thematicOverlap * overlap + W.location * (sameLocation ? 1 : 0);
  return { score, overlap, polaritySame: prop.polarity === fact.polarity, sameLocation };
}

/** 在聊天的事实里找与该命题最匹配的一条 (达阈值才算) */
function findMatchingFact(db, prop) {
  const facts = db.prepare(`
    SELECT * FROM v_facts
    WHERE chat_id = ? AND id <> ? AND status IN (${FACT_STATUSES.map(() => '?').join(', ')})
  `).all(prop.chat_id, prop.id, ...FACT_STATUSES);

  let best = null;
  for (const f of facts) {
    const m = matchScore(db, prop, f);
    if (m && m.score >= A.threshold && (!best || m.score > best.score)) best = { fact: f, ...m };
  }
  return best;
}

/**
 * 「到点」判定: 未来命题所在时间节点之后又出现了更晚的时间节点 => 那个"明天"已经过去。
 * 无时间锚的命题一律不判到点 (宁可留着未决, 也不凭空判落空)。
 */
function isDue(db, prop) {
  if (prop.tense !== 'future') return false;
  if (prop.time_id == null) return false;
  const cur = db.prepare('SELECT seq FROM time_points WHERE id = ?').get(prop.time_id)?.seq;
  const max = db.prepare('SELECT MAX(seq) AS m FROM time_points WHERE chat_id = ?').get(prop.chat_id)?.m;
  return cur != null && max != null && max > cur;
}

function setStatus(db, id, status, alignedInstanceId = null) {
  db.prepare('UPDATE events SET status = ?, aligned_instance_id = ?, updated_at = ? WHERE id = ?')
    .run(status, alignedInstanceId, now(), id);
}

/** 条件前件是否已被判定为"不成立" */
function conditionResolvedNegatively(db, propId) {
  const cond = db.prepare(`
    SELECT c.* FROM event_links k JOIN events c ON c.id = k.from_id
    WHERE k.to_id = ? AND k.relation = 'conditional'
  `).get(propId);
  if (!cond) return false;
  return ['failed', 'refuted', 'voided'].includes(cond.status);
}

/** 同一父实例下的 alt 候选: 有一个兑现则其余作废 */
function voidSiblings(db, prop) {
  if (prop.parent_role !== 'alt' || prop.parent_instance_id == null) return 0;
  const info = db.prepare(`
    UPDATE events SET status = 'voided', updated_at = ?
    WHERE parent_instance_id = ? AND parent_role = 'alt' AND id <> ? AND status = 'pending'
  `).run(now(), prop.parent_instance_id, prop.id);
  return info.changes;
}

/**
 * 从句到宿主的级联 —— 这条规则就是"谎话被拆穿"的机制:
 *   从句已兑现  => 宿主(她说的话)为真  -> 宿主 realized (证实)
 *   从句被推翻/落空 => 宿主为假        -> 宿主 refuted (撒谎 / 记错 / 说错了)
 * 只作用于 parent_role='comp' 且宿主仍处 pending 的情形。
 */
function cascadeToHost(db, comp) {
  if (comp.parent_role !== 'comp' || comp.parent_instance_id == null) return null;
  const host = db.prepare('SELECT * FROM events WHERE id = ?').get(comp.parent_instance_id);
  if (!host || host.status !== 'pending') return null;

  const siblings = db.prepare(`
    SELECT status FROM events WHERE parent_instance_id = ? AND parent_role = 'comp'
  `).all(host.id).map((r) => r.status);

  let status = null;
  if (comp.status === 'refuted' || comp.status === 'failed') status = 'refuted';
  else if (comp.status === 'realized' && siblings.every((s) => s === 'realized')) status = 'realized';
  if (!status) return null;

  setStatus(db, host.id, status, comp.aligned_instance_id ?? null);
  return { id: host.id, verb: host.verb_type, via: comp.id, status };
}

/**
 * 跑一轮对齐 (可指定聊天, 也可全库)。
 * 顺序有意为之: 先兑现/推翻 -> 再级联到宿主(证实/拆穿) -> 再传播条件未激活 -> 再判落空 -> 最后择一作废。
 * (择一作废放最后: 它依赖"谁已经兑现"这个终局结果)
 */
export function alignPropositions(db, { chatId = null, nowTs = null } = {}) {
  const result = { realized: [], refuted: [], hostRealized: [], hostRefuted: [], inactive: [], failed: [], voided: [] };

  const pendingOf = () => (chatId
    ? db.prepare(`${PENDING_SQL} AND chat_id = ? ORDER BY id`).all(chatId)
    : db.prepare(`${PENDING_SQL} ORDER BY id`).all());

  const run = db.transaction(() => {
    // 1) 命题 ⇄ 事实 (有未决从句的实例跳过: 由从句去对齐, 见 hasPendingComp)
    //    择一候选 (parent_role='alt') 不在此处独立判定 —— 它们要**互相竞争**, 见 1b。
    const altGroups = new Map();
    for (const p of pendingOf()) {
      if (hasPendingComp(db, p.id)) continue;
      if (p.parent_role === 'alt' && p.parent_instance_id != null) {
        if (!altGroups.has(p.parent_instance_id)) altGroups.set(p.parent_instance_id, []);
        altGroups.get(p.parent_instance_id).push(p);
        continue;
      }
      const m = findMatchingFact(db, p);
      if (!m) continue;
      const status = m.polaritySame ? 'realized' : 'refuted';
      setStatus(db, p.id, status, m.fact.id);
      result[status].push({ id: p.id, verb: p.verb_type, factId: m.fact.id, score: Number(m.score.toFixed(3)) });
    }

    // 1b) 择一: 同组候选里**打分最高者**胜出, 其余作废。
    //     不能各自独立判定 —— 那会让两个候选同时"兑现", 等于说两件事都发生了 (析取的语义是择一)。
    for (const [, group] of altGroups) {
      const scored = group
        .map((p) => ({ p, m: findMatchingFact(db, p) }))
        .filter((x) => x.m)
        .sort((a, b) => (b.m.score - a.m.score) || (a.p.id - b.p.id));
      if (!scored.length) continue;                       // 都没匹配上 -> 全体保持未决
      const winner = scored[0];
      const status = winner.m.polaritySame ? 'realized' : 'refuted';
      setStatus(db, winner.p.id, status, winner.m.fact.id);
      result[status].push({
        id: winner.p.id, verb: winner.p.verb_type, factId: winner.m.fact.id,
        score: Number(winner.m.score.toFixed(3)), alternative: true,
      });
      if (status === 'realized') {
        for (const loser of group) {
          if (loser.id === winner.p.id) continue;
          if (db.prepare('SELECT status FROM events WHERE id = ?').get(loser.id).status !== 'pending') continue;
          setStatus(db, loser.id, 'voided');
        }
        result.voided.push({ parentId: winner.p.parent_instance_id, count: group.length - 1 });
      }
    }

    // 2) 从句结果级联到宿主 (证实 / 拆穿)
    const changed = chatId
      ? db.prepare("SELECT * FROM events WHERE parent_role = 'comp' AND status IN ('realized','refuted','failed') AND chat_id = ?").all(chatId)
      : db.prepare("SELECT * FROM events WHERE parent_role = 'comp' AND status IN ('realized','refuted','failed')").all();
    for (const comp of changed) {
      const host = cascadeToHost(db, comp);
      if (!host) continue;
      result[host.status === 'realized' ? 'hostRealized' : 'hostRefuted'].push(host);
    }

    // 3) 条件未成立 -> 后果未激活
    for (const p of pendingOf()) {
      if (!conditionResolvedNegatively(db, p.id)) continue;
      setStatus(db, p.id, 'inactive');
      result.inactive.push({ id: p.id, verb: p.verb_type });
    }

    // 4) 到点未兑现 -> 落空
    for (const p of pendingOf()) {
      if (!isDue(db, p)) continue;
      setStatus(db, p.id, 'failed');
      result.failed.push({ id: p.id, verb: p.verb_type });
    }

    // 5) 择一: 把已兑现的候选的兄弟作废
    const realized = chatId
      ? db.prepare("SELECT * FROM events WHERE status = 'realized' AND parent_role = 'alt' AND chat_id = ?").all(chatId)
      : db.prepare("SELECT * FROM events WHERE status = 'realized' AND parent_role = 'alt'").all();
    for (const p of realized) {
      const n = voidSiblings(db, p);
      if (n) result.voided.push({ parentId: p.parent_instance_id, count: n });
    }
  });

  run();
  return result;
}

/**
 * 单条事实落库后的即时对齐 (写入时调用, 集合小)。
 * @returns 同 alignPropositions 的摘要
 */
export function alignByInstance(db, instanceId) {
  const fact = db.prepare('SELECT * FROM events WHERE id = ?').get(instanceId);
  if (!fact) return { realized: [], refuted: [], hostRealized: [], hostRefuted: [], inactive: [], failed: [], voided: [] };
  const result = { realized: [], refuted: [], hostRealized: [], hostRefuted: [], inactive: [], failed: [], voided: [] };

  const run = db.transaction(() => {
    const props = db.prepare(`${PENDING_SQL} AND chat_id = ? ORDER BY id`).all(fact.chat_id);
    for (const p of props) {
      if (hasPendingComp(db, p.id)) continue;
      const m = matchScore(db, p, fact);
      if (!m || m.score < A.threshold) continue;
      const status = m.polaritySame ? 'realized' : 'refuted';
      setStatus(db, p.id, status, fact.id);
      result[status].push({ id: p.id, verb: p.verb_type, factId: fact.id, score: Number(m.score.toFixed(3)) });
      if (status === 'realized') {
        const n = voidSiblings(db, { ...p, status: 'realized' });
        if (n) result.voided.push({ parentId: p.parent_instance_id, count: n });
      }
      const host = cascadeToHost(db, { ...p, status });
      if (host) result[host.status === 'realized' ? 'hostRealized' : 'hostRefuted'].push(host);
    }
  });
  run();
  return result;
}
