// 组合抽取: 一次调用完成"事件要素 → 属性观察 → 关系立场"。
//
// 存在的理由 (不是省事, 是正确性):
//   三段必须吃**同一段文本**与**同一组来源楼层**。分开调用时这一点只靠调用方纪律维持,
//   一旦传错, 事件/属性/立场描述的不是同一段剧情, 且追溯链错位 —— 静默且难发现。
//   把顺序与共享入参收进服务端后, 调用方无从传错。
//
// 两种模式 (默认 merged):
//   merged —— **一次 LLM 调用**产出三层(见 mergedExtraction): 输入只送一遍,
//             且模型能在同一次阅读里用实例 label 把观察/立场锚到触发它的事件上
//             (分开抽时这一步物理上做不到, 锚点永远为空)。
//   split  —— 三步并行各调一次 LLM。用途: ①`steps` 只补跑某一层 ②merged 整份解析失败时的降级兜底。
//
// 失败策略 (与 /api/extract 的"整步报错"不同):
//   单层失败不中断其余层 —— 三层互不依赖, 一起失败只会丢更多数据。失败如实记在
//   steps.<id> { ok:false, error }, 顶层 ok 仍为 true。
import { OBSERVE_PIPELINE } from '../domain/constants.js';
import { extractInstances } from './extractionService.js';
import { extractAttributes } from './chunkExtractionService.js';
import { extractStances } from './stanceExtractionService.js';
import { extractAll } from './mergedExtraction.js';

/** 每步的执行体 (split 模式): 入参（共享文本 + 共享来源）由本模块统一绑定, 步与步之间不传结果 */
// 注意: 三个抽取器的形参形状并不一致 —— extractInstances 是 (db, llm, opts),
// 另外两个是 (db, { llm, embed, ... })。这里按各自的真实签名适配, 顺便把这个不一致
// 收敛到本文件一处, 不让它扩散到调用方。
const RUNNERS = {
  instances: (db, clients, input) => extractInstances(db, clients.llm, {
    chatId: input.chatId,
    text: input.text,
    sourceMessageIds: input.sourceMessageIds,
    writeMemory: input.writeMemory,
    characterName: input.characterName,
    userName: input.userName,
  }),
  attributes: (db, clients, input) => extractAttributes(db, {
    llm: clients.llm,
    embed: clients.embed,
    chatId: input.chatId,
    text: input.text,
    sourceMessageIds: input.sourceMessageIds,
  }),
  stances: (db, clients, input) => extractStances(db, {
    llm: clients.llm,
    chatId: input.chatId,
    text: input.text,
    sourceMessageIds: input.sourceMessageIds,
  }),
};

/** 单步分区 id → 合并输出的分区名 (命名不同: 单步叫 attributes, 合并输出里叫 observations) */
const ZONE_OF_STEP = { instances: 'instances', attributes: 'observations', stances: 'stances' };

/**
 * 从步骤报告里算"这次到底写没写进去"。
 *
 * 顶层 ok 表达的是"请求被处理了", 不是"记忆写成了" —— 单层失败不中断其余层,
 * 所以要如实报"打算跑几步、真跑了几步、几步真失败了", 让调用方(与模型)能一眼看出
 * "这次 observe 其实没落下任何东西"。skipped (如 embedding 不可用) 不算失败, 它没打算跑。
 */
function outcomeOf(stepsRun, report) {
  const attempted = stepsRun.filter((id) => report[id] && !report[id].skipped);
  const failedSteps = attempted.filter((id) => report[id].ok !== true);
  const skippedSteps = stepsRun.filter((id) => report[id]?.skipped === true);
  return {
    failedSteps,
    skippedSteps,
    // 全部打算跑的步都失败 = 这一轮一行都没落库 (调用方据此报警, 见 MCP_NUDGE.failedHint)
    allFailed: attempted.length > 0 && failedSteps.length === attempted.length,
  };
}

/**
 * 跑组合抽取。
 * @param {object} db
 * @param {{llm:object, embed:object|null}} clients embed 传 null 表示不可用 (调用方用同一套可用性判定)
 * @param {object} opts
 * @param {'merged'|'split'} [opts.mode] 缺省 merged; 给了 steps 时强制 split (补跑语义)
 * @param {string[]} [opts.steps] 只跑指定层 (按管线顺序)
 */
export async function observeText(db, clients, {
  chatId, text, sourceMessageIds = [], characterName = null, userName = null,
  writeMemory = true, steps = null, mode = null,
} = {}) {
  if (!chatId) throw new Error('chatId 必填');
  if (!text || !text.trim()) throw new Error('text 不能为空');
  if (!clients?.llm) throw new Error('LLM 客户端未初始化');

  const wanted = Array.isArray(steps) && steps.length ? new Set(steps) : null;
  const unknown = wanted ? [...wanted].filter((s) => !OBSERVE_PIPELINE.some((p) => p.id === s)) : [];
  if (unknown.length) throw new Error(`未知的抽取步: ${unknown.join(', ')}`);

  // 共享入参在进入任何路径前一次性绑定 —— 这是本入口存在的全部意义
  const input = Object.freeze({
    chatId,
    text,
    sourceMessageIds: [...sourceMessageIds],
    characterName,
    userName,
    writeMemory,
  });

  // 补跑语义 (只跑某几层) 走分步: 合并输出无法只产出一层, 强行做只会浪费一半输出
  const chosen = wanted ? 'split' : (mode ?? 'merged');
  if (chosen === 'split') {
    const r = await runSplit(db, clients, input, wanted);
    return { ...r, mode: 'split', llmCalls: r.stepsRun.length };
  }

  // ===== merged: 一次调用; 整份解析失败才降级 (降级会写库, 所以只在"什么都没有"时做) =====
  try {
    const merged = await extractAll(db, clients, {
      ...input,
      omitObservations: !clients.embed,
    });
    const stepsReport = {};
    for (const step of OBSERVE_PIPELINE) {
      const zoneKey = ZONE_OF_STEP[step.id];
      const payload = merged.zone[zoneKey];
      if (step.needsEmbedding && !clients.embed) {
        stepsReport[step.id] = {
          ok: false, skipped: true,
          skippedReason: 'embedding 未配置或不可用, 该层跳过',
        };
      } else {
        stepsReport[step.id] = { ok: true, ...payload };
      }
    }
    return {
      ok: true,
      chatId,
      mode: 'merged',
      llmCalls: 1,
      stepsRun: OBSERVE_PIPELINE.map((p) => p.id),
      partial: OBSERVE_PIPELINE.some((p) => stepsReport[p.id]?.ok !== true),
      ...outcomeOf(OBSERVE_PIPELINE.map((p) => p.id), stepsReport),
      zones: merged.zones,
      // 合并输出里**没出现**的分区键 (截断与"确实没有"同形, 只上报不猜): 有值时提示调用方补跑该层
      missingZones: merged.missingZones,
      // 锚点命中情况: 有多少条观察/立场真的挂到了触发它的事件上 (合并抽取独有的收益)
      anchored: merged.anchored,
      steps: stepsReport,
    };
  } catch (err) {
    console.warn(`[observe] 合并抽取失败, 降级为分步并行: ${err.message}`);
    const r = await runSplit(db, clients, input, null);
    return {
      ...r,
      mode: 'split-fallback',
      llmCalls: r.stepsRun.length,
      mergedError: err.message,
    };
  }
}

/**
 * 分步路径: 三步并行各调一次。
 * 并行而不是串行 —— 三者互不依赖, 每轮都编织时延迟最敏感, 串行等于叠三倍。
 * 写库仍安全: better-sqlite3 是同步 API, Node 单线程下每个 step 的落库块(含事务)
 * 整块执行, 不会与另一步交错; 同名实体也不会重复插入。
 */
async function runSplit(db, clients, input, wanted) {
  const report = {};
  const stepsRun = [];
  const plan = [];
  for (const step of OBSERVE_PIPELINE) {
    if (wanted && !wanted.has(step.id)) continue;
    stepsRun.push(step.id);
    if (step.needsEmbedding && !clients.embed) {
      report[step.id] = { ok: false, skipped: true, skippedReason: 'embedding 未配置或不可用, 该步跳过' };
      continue;
    }
    plan.push(step);
  }

  const results = await Promise.all(plan.map(async (step) => {
    try {
      return [step.id, { ok: true, ...(await RUNNERS[step.id](db, clients, input)) }];
    } catch (err) {
      console.warn(`[observe] ${step.id} 步失败, 其余步照常: ${err.message}`);
      return [step.id, { ok: false, error: err.message }];
    }
  }));
  // 按管线顺序回填, 让 steps 的键序稳定 (报告可读性, 与执行顺序无关)
  for (const step of OBSERVE_PIPELINE) {
    const hit = results.find(([id]) => id === step.id);
    if (hit) report[hit[0]] = hit[1];
  }

  return {
    ok: true,
    chatId: input.chatId,
    stepsRun,
    partial: stepsRun.some((id) => report[id]?.ok !== true),
    ...outcomeOf(stepsRun, report),
    steps: report,
  };
}
