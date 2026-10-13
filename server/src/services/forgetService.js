// 遗忘衰减任务: 对 memories / attribute_chunks / stances 统一算衰减分, 低分软遗忘
// 原则(与结构层一致): 遗忘 = is_active 置 0, 不物理删, 可恢复
// 打分权重/半衰期/默认阈值统一来自 domain/constants.js (与 GET /api/meta 同源)
import { now } from '../utils/text.js';
import { FORGET_SCORING, FORGET_TABLES } from '../domain/constants.js';

const HALF_LIFE_DAYS = FORGET_SCORING.halfLifeDays;
const W_IMPORTANCE = FORGET_SCORING.weights.importance;
const W_RECENCY = FORGET_SCORING.weights.recency;
const W_FREQUENCY = FORGET_SCORING.weights.frequency;
const FREQ_SATURATION = FORGET_SCORING.frequencySaturation; // 访问次数归一饱和点

// stances 无访问追踪列 (schema 冻结), 权重重归一: 0.6*importance + 0.4*recency
const NO_ACCESS_W_IMPORTANCE = FORGET_SCORING.noAccessWeights.importance;
const NO_ACCESS_W_RECENCY = FORGET_SCORING.noAccessWeights.recency;

const DEFAULTS = FORGET_SCORING.defaults;

// 表清单 (name/label/hasAccess) 与 /api/meta 的 enums.forgetTable 同源
const TABLES = FORGET_TABLES.map((t) => ({ name: t.value, label: t.label, hasAccess: t.hasAccess }));

function recencyScore(tsSeconds, nowTs) {
  if (!tsSeconds) return 0;
  const ageDays = (nowTs - tsSeconds) / 86400;
  return Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
}

function frequencyScore(accessCount) {
  return Math.min((accessCount ?? 0) / FREQ_SATURATION, 1);
}

// 扫描候选 (不改库): 返回每张表的低分待遗忘项
export function scanForgetCandidates(db, {
  threshold = DEFAULTS.threshold, minAgeDays = DEFAULTS.minAgeDays,
  protectImportance = DEFAULTS.protectImportance, nowTs = now(),
} = {}) {
  const candidates = [];
  for (const t of TABLES) {
    const cols = t.hasAccess
      ? 'id, importance, access_count, last_accessed_at, created_at'
      : 'id, importance, created_at';
    const rows = db.prepare(`SELECT ${cols} FROM ${t.name} WHERE is_active = 1`).all();
    for (const r of rows) {
      const ageDays = (nowTs - r.created_at) / 86400;
      if (ageDays < minAgeDays) continue;                    // 太新, 保护
      if (r.importance >= protectImportance) continue;       // 高重要度, 保护
      const recency = recencyScore(
        t.hasAccess ? (r.last_accessed_at ?? r.created_at) : r.created_at, nowTs
      );
      const score = t.hasAccess
        ? W_IMPORTANCE * r.importance + W_RECENCY * recency + W_FREQUENCY * frequencyScore(r.access_count)
        : NO_ACCESS_W_IMPORTANCE * r.importance + NO_ACCESS_W_RECENCY * recency;
      if (score < threshold) {
        candidates.push({
          table: t.name, label: t.label, id: r.id,
          score: Number(score.toFixed(4)),
          ageDays: Math.floor(ageDays),
          importance: r.importance,
          accessCount: r.access_count ?? 0,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.score - b.score);
}

// 遗忘任务入口: 默认 dry-run 只扫描; confirm=true 才执行软删 (事务)
export function runForgetTask(db, {
  threshold = DEFAULTS.threshold, minAgeDays = DEFAULTS.minAgeDays,
  protectImportance = DEFAULTS.protectImportance, confirm = false,
} = {}) {
  const candidates = scanForgetCandidates(db, { threshold, minAgeDays, protectImportance });
  if (!confirm || candidates.length === 0) {
    return {
      dryRun: !confirm, candidateCount: candidates.length,
      forgotten: [], forgottenCount: 0, candidates,
    };
  }

  const ts = now();
  const stmts = Object.fromEntries(TABLES.map((t) => [
    t.name,
    db.prepare(`UPDATE ${t.name} SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`),
  ]));
  const forgotten = [];
  db.transaction(() => {
    for (const c of candidates) {
      const info = stmts[c.table].run(ts, c.id);
      if (info.changes > 0) forgotten.push(c);
    }
  })();

  return {
    dryRun: false,
    candidateCount: candidates.length,
    forgotten,
    forgottenCount: forgotten.length,
  };
}

// 恢复 (遗忘可逆): 手动把软遗忘的条目捞回来
export function restoreForgotten(db, { table, id }) {
  if (!TABLES.some((t) => t.name === table)) throw new Error(`不支持的表: ${table}`);
  const info = db.prepare(
    `UPDATE ${table} SET is_active = 1, updated_at = ? WHERE id = ? AND is_active = 0`
  ).run(now(), id);
  return info.changes > 0;
}
