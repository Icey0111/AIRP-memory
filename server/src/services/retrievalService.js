// 检索闭环: FTS 召回 + 向量召回(观察块) -> 统一打分 -> top-k -> 注入组装
//
// 本文件现在只做两件事:
//   1) 转出召回函数 (实现在 memorySearch.js, 供注入段注册表复用)
//   2) 组装: 按注入段注册表跑段, 把段产出的字段收成响应
// 段顺序/依赖/计数口径都在 injectionSections.js 里声明, 这里不再手写八段。
import { RETRIEVAL_FALLBACK_DEFAULTS } from '../domain/constants.js';
import {
  INJECTION_SECTIONS, createState, runSections, sectionOrder, prepareOrder, sectionFields,
} from './injectionSections.js';
import { searchMemories, searchChunks } from './memorySearch.js';
import { buildDigest } from './digestService.js';

// 兼容既有调用方 (routes / 测试 / check-contract 都从本模块导入这两个名字)
export { searchMemories, searchChunks };

// 段注册表对外再导出一次, 便于测试与工具直接引用同一份真源
export { INJECTION_SECTIONS, sectionOrder, prepareOrder, sectionFields };

/**
 * 注入组装: 角色画像 + 关系立场 + 关键实体 + 前情提要 + 事件时间线 + 待兑现
 *          + 相关记忆(FTS) + 相关细节(向量)
 *
 * 两种形态 (开关见 INJECTION_TABLES.enabled / 请求体 injectTables):
 *   'tables'  —— 常驻段表格化 (对齐纯文本), 检索段行化 (紧凑 markdown)
 *   'bullets' —— 原有的平铺 bullet 路径, 无损回退口径
 * 表格渲染抛错时自动回退 bullet 并记 warn: 注入永远不断供, 生成本身不受影响。
 */
export async function assembleContext(db, embed, {
  query, chatId = null, characterId = null,
  topK = RETRIEVAL_FALLBACK_DEFAULTS.topK,
  tokenBudget = RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget,
  digestMaxTokens = null,
  injectTables = null,
  injectStances = null,
  injectPending = null,
} = {}) {
  const state = createState({
    db,
    embed,
    args: {
      query, chatId, characterId, topK, tokenBudget, digestMaxTokens,
      injectTables, injectStances, injectPending,
    },
  });

  await runSections(state);

  const fields = {};
  for (const s of sectionOrder()) Object.assign(fields, s.fields, state.fields[s.id] ?? {});

  return {
    text: state.sections.join('\n\n'),
    // usedTokens 只表示检索预算 (相关记忆 + 相关细节) 的用量; 常驻段各有独立预算
    usedTokens: state.usedTokens,
    tokenBudget,
    ...fields,
    tablesEnabled: state.flags.tablesOn,
    stancesEnabled: state.flags.stancesOn,
    // tables: 全部表格化 | bullets: 全回退 | mixed: 部分段回退
    injectionMode: !state.flags.tablesOn ? 'bullets' : (state.fellBack ? 'mixed' : 'tables'),
  };
}
