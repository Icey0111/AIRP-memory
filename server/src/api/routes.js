// API 路由: /health /api/status /api/memories /api/profiles /api/retrieve /api/context
//           /api/extract /api/chunks /api/extract-attributes /api/profiles-derive
//           /api/stances /api/extract-stances /api/forget /api/forget/restore
import { Router } from 'express';
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/migrate.js';
import {
  createMemory, getMemory, listMemories, updateMemory, deactivateMemory,
} from '../services/memoryService.js';
import {
  getProfile, upsertProfileEntry, deleteProfileEntry,
} from '../services/profileService.js';
import { searchMemories, searchChunks, assembleContext } from '../services/retrievalService.js';
import { extractSixElements } from '../services/extractionService.js';
import { addChunk, listChunks, softDeleteChunk, stripEmbedding } from '../services/chunkService.js';
import { extractAttributes, deriveProfile } from '../services/chunkExtractionService.js';
import { addStance, listStances, softDeleteStance, stanceOverview } from '../services/stanceService.js';
import { extractStances } from '../services/stanceExtractionService.js';
import { summarizeConversation } from '../services/summaryService.js';
import { runForgetTask, restoreForgotten } from '../services/forgetService.js';
import { buildDigest } from '../services/digestService.js';
import { RETRIEVAL_FALLBACK_DEFAULTS, FORGET_SCORING, SUMMARY_MEMORY_TYPE } from '../domain/constants.js';
import { buildMeta } from './meta.js';

const CORE_TABLES = [
  'memories', 'memory_tags', 'memory_links', 'character_profiles',
  'people', 'locations', 'time_points', 'events', 'event_participants',
  'event_links', 'memory_entity_refs', 'attribute_chunks',
  'items', 'orgs', 'stances', 'retrieval_log',
];

// 统一错误包装: service 抛 Error -> 400, 未知异常 -> 500
function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message });
    }
  };
}

// 异步版本
function handleAsync(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      res.status(err.status || 400).json({ ok: false, error: err.message });
    });
  };
}

// 能力判定: 客户端"存在" 且 "配置完整"。
// 只判断存在性会把"客户端在但未配置"误判为可用, 使本该静默降级的端点抛 400,
// 与 /api/meta 中 degrade='silent' 的声明矛盾 —— 前后端语义必须一致。
function usable(client) {
  if (!client) return false;
  if (typeof client.describe !== 'function') return true;
  return client.describe().configured === true;
}

export function createRouter(db, { llm = null, embed = null, retrieval = {}, runtime = {} } = {}) {
  const router = Router();

  // 默认检索参数: 优先取 config.retrieval, 兜底取领域常量 (与 /api/meta 报告的值同源)
  const defaultTopK = Number(retrieval.topK) || RETRIEVAL_FALLBACK_DEFAULTS.topK;
  const defaultTokenBudget = Number(retrieval.tokenBudget) || RETRIEVAL_FALLBACK_DEFAULTS.tokenBudget;

  // ---------- 运维 ----------
  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'tavern-memory-server' });
  });

  router.get('/api/status', (req, res) => {
    const counts = {};
    for (const t of CORE_TABLES) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    res.json({
      ok: true,
      schemaVersion: getSchemaVersion(db),
      latestSupported: LATEST_SCHEMA_VERSION,
      counts,
    });
  });

  // 契约描述: 前后端唯一语义源。前端 UI 的枚举/默认值/公式/能力依赖全部从这里取,
  // 不在前端另写一份, 避免两端语义漂移。
  router.get('/api/meta', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildMeta(db, {
      llm,
      embed,
      retrieval: { topK: defaultTopK, tokenBudget: defaultTokenBudget },
      runtime,
    }));
  });

  // ---------- 一阶记忆 ----------
  router.post('/api/memories', handle((req, res) => {
    res.json({ ok: true, memory: createMemory(db, req.body ?? {}) });
  }));

  router.get('/api/memories', handle((req, res) => {
    const { chatId, characterId, scope, type, includeInactive, limit, offset } = req.query;
    res.json({
      ok: true,
      memories: listMemories(db, {
        chatId, characterId, scope, type,
        includeInactive: includeInactive === '1',
        limit: Number(limit) || 50,
        offset: Number(offset) || 0,
      }),
    });
  }));

  router.get('/api/memories/:id', handle((req, res) => {
    const memory = getMemory(db, Number(req.params.id));
    if (!memory) return res.status(404).json({ ok: false, error: '记忆不存在' });
    res.json({ ok: true, memory });
  }));

  router.patch('/api/memories/:id', handle((req, res) => {
    const memory = updateMemory(db, Number(req.params.id), req.body ?? {});
    if (!memory) return res.status(404).json({ ok: false, error: '记忆不存在' });
    res.json({ ok: true, memory });
  }));

  // 软删除 (遗忘)
  router.delete('/api/memories/:id', handle((req, res) => {
    const done = deactivateMemory(db, Number(req.params.id));
    if (!done) return res.status(404).json({ ok: false, error: '记忆不存在' });
    res.json({ ok: true });
  }));

  // ---------- 生效画像 ----------
  router.get('/api/profiles/:characterId', handle((req, res) => {
    res.json({ ok: true, profile: getProfile(db, req.params.characterId) });
  }));

  router.put('/api/profiles/:characterId', handle((req, res) => {
    const { category, key, value, derivedFromChunkIds } = req.body ?? {};
    const entry = upsertProfileEntry(db, {
      characterId: req.params.characterId, category, key, value, derivedFromChunkIds,
    });
    res.json({ ok: true, entry });
  }));

  router.delete('/api/profiles/:characterId', handle((req, res) => {
    const { category, key } = req.body ?? {};
    const done = deleteProfileEntry(db, req.params.characterId, category, key);
    if (!done) return res.status(404).json({ ok: false, error: '画像条目不存在' });
    res.json({ ok: true });
  }));

  // ---------- 检索与注入 ----------
  // FTS 召回记忆; embed 可用时附带向量召回的观察块 (第三路)
  // 注意: 用 usable() 而非 !!embed —— embedding 未配置时必须静默降级, 不能抛错
  const embedIfUsable = usable(embed) ? embed : null;

  router.post('/api/retrieve', handleAsync(async (req, res) => {
    const { query, chatId, characterId, topK, withChunks, includeSummaries, digestMaxTokens } = req.body ?? {};
    const k = Number(topK) || defaultTopK;
    // 与 /api/context 保持一致: 默认排除摘要 (它们走【前情提要】常驻), 只看这里是否真要原文
    const { hits, match } = searchMemories(db, {
      query, chatId, characterId, topK: k,
      excludeTypes: includeSummaries === true ? null : [SUMMARY_MEMORY_TYPE],
    });
    // 前情提要与相似度召回是两条独立通道, 调试时也要能看到它实际会注入什么
    const out = { ok: true, match, hits, digest: buildDigest(db, { chatId, maxTokens: digestMaxTokens }) };
    if (embedIfUsable && query && withChunks !== false) {
      const { hits: chunkHits } = await searchChunks(db, embedIfUsable, { query, chatId, topK: k });
      out.chunkHits = chunkHits;
    }
    res.json(out);
  }));

  router.post('/api/context', handleAsync(async (req, res) => {
    const { query, chatId, characterId, topK, tokenBudget, digestMaxTokens } = req.body ?? {};
    res.json({
      ok: true,
      ...(await assembleContext(db, embedIfUsable, {
        query, chatId, characterId,
        topK: Number(topK) || defaultTopK,
        tokenBudget: Number(tokenBudget) || defaultTokenBudget,
        // 0 / 缺省 = 用服务端策略默认值 (与 topK / tokenBudget 同一约定)
        digestMaxTokens: Number(digestMaxTokens) > 0 ? Number(digestMaxTokens) : null,
      })),
    });
  }));

  // ---------- 二阶六要素抽取 (LLM) ----------
  router.post('/api/extract', handleAsync(async (req, res) => {
    if (!llm) throw new Error('LLM 客户端未初始化');
    const { chatId, text, sourceMessageIds, writeMemory } = req.body ?? {};
    res.json(await extractSixElements(db, llm, {
      chatId, text,
      sourceMessageIds: sourceMessageIds ?? [],
      writeMemory: writeMemory !== false,
    }));
  }));

  // ---------- 三阶属性观察块 ----------
  // 手动写入 (embed 可用时自动补向量; 未配置则静默降级 embedded:false)
  router.post('/api/chunks', handleAsync(async (req, res) => {
    const {
      entityType, entityId, aspect, content, importance,
      chatId, memoryId, sourceMessageIds, validFromEventId, validToEventId,
    } = req.body ?? {};
    let embeddingVec = null;
    let embeddingModel = null;
    if (embedIfUsable && content) {
      [embeddingVec] = await embedIfUsable.embed([content]);
      embeddingModel = embedIfUsable.model;
    }
    const id = addChunk(db, {
      entityType, entityId, aspect, content,
      embeddingVec, embeddingModel,
      importance: importance ?? 0.5,
      chatId: chatId ?? null,
      memoryId: memoryId ?? null,
      sourceMessageIds: sourceMessageIds ?? [],
      validFromEventId: validFromEventId ?? null,
      validToEventId: validToEventId ?? null,
    });
    res.json({ ok: true, id, embedded: embeddingVec !== null });
  }));

  // 当前生效列表 (includeHistory=1 时含被覆盖/历史块)
  router.get('/api/chunks', handle((req, res) => {
    const { entityType, entityId, includeHistory } = req.query;
    if (!entityType || !entityId) {
      return res.status(400).json({ ok: false, error: 'entityType/entityId 必填' });
    }
    res.json({
      ok: true,
      chunks: listChunks(db, {
        entityType, entityId: Number(entityId),
        includeHistory: includeHistory === '1',
      }).map(stripEmbedding),
    });
  }));

  // 软删除 (遗忘, 不物理删)
  router.delete('/api/chunks/:id', handle((req, res) => {
    const done = softDeleteChunk(db, Number(req.params.id));
    if (!done) return res.status(404).json({ ok: false, error: '观察块不存在或已删除' });
    res.json({ ok: true });
  }));

  // ---------- 三阶抽取管线 (LLM + embedding) ----------
  router.post('/api/extract-attributes', handleAsync(async (req, res) => {
    if (!llm) throw new Error('LLM 客户端未初始化');
    if (!embed) throw new Error('embedding 客户端未初始化');
    const { chatId, text, sourceMessageIds } = req.body ?? {};
    res.json({
      ok: true,
      ...(await extractAttributes(db, {
        llm, embed, chatId, text,
        sourceMessageIds: sourceMessageIds ?? [],
      })),
    });
  }));

  // 画像重归纳: 当前生效观察块 -> character_profiles
  router.post('/api/profiles-derive', handleAsync(async (req, res) => {
    if (!llm) throw new Error('LLM 客户端未初始化');
    const { personId, characterId } = req.body ?? {};
    if (!personId || !characterId) throw new Error('personId/characterId 必填');
    res.json({
      ok: true,
      ...(await deriveProfile(db, { llm, personId: Number(personId), characterId })),
    });
  }));

  // ---------- 长对话压缩 (LLM) ----------
  // 前端累计估算 token 达阈值时调用; 阈值来自 /api/meta 的 summaryPolicy
  router.post('/api/summarize', handleAsync(async (req, res) => {
    if (!llm) throw new Error('LLM 客户端未初始化');
    const {
      chatId, text, sourceMessageIds, characterId,
      inWorldTime, keywords, importance, maxChars, dedupe,
    } = req.body ?? {};
    res.json(await summarizeConversation(db, llm, {
      chatId, text,
      sourceMessageIds: sourceMessageIds ?? [],
      characterId: characterId ?? null,
      inWorldTime: inWorldTime ?? null,
      keywords: keywords ?? '',
      importance: importance ?? null,
      maxChars: maxChars ?? null,
      dedupe: dedupe !== false,
    }));
  }));

  // ---------- V4 相对立场 ----------
  // 手动写入
  router.post('/api/stances', handle((req, res) => {
    const {
      holderType, holderId, targetType, targetId, stanceType, intensity,
      displayedType, isPublic, targetAware, basis,
      chatId, memoryId, sourceMessageIds, importance,
      validFromEventId, validToEventId, supersedesStanceId,
    } = req.body ?? {};
    const id = addStance(db, {
      holderType, holderId: Number(holderId),
      targetType, targetId: Number(targetId),
      stanceType, intensity: intensity ?? 0.5,
      displayedType: displayedType ?? null,
      isPublic: isPublic !== false, targetAware: targetAware !== false,
      basis: basis ?? '',
      chatId, memoryId: memoryId ?? null,
      sourceMessageIds: sourceMessageIds ?? [],
      importance: importance ?? 0.5,
      validFromEventId: validFromEventId ?? null,
      validToEventId: validToEventId ?? null,
      supersedesStanceId: supersedesStanceId ?? null,
    });
    res.json({ ok: true, id });
  }));

  // 某实体的立场列表 (overview=1 带对端名称; includeHistory=1 含被覆盖历史)
  router.get('/api/stances', handle((req, res) => {
    const { holderType, holderId, chatId, includeHistory, overview } = req.query;
    if (!holderType || !holderId) {
      return res.status(400).json({ ok: false, error: 'holderType/holderId 必填' });
    }
    const opts = {
      holderType, holderId: Number(holderId), chatId: chatId ?? null,
      includeHistory: includeHistory === '1',
    };
    const stances = overview === '1'
      ? stanceOverview(db, opts)
      : listStances(db, opts);
    res.json({ ok: true, stances });
  }));

  // 软删除
  router.delete('/api/stances/:id', handle((req, res) => {
    const done = softDeleteStance(db, Number(req.params.id));
    if (!done) return res.status(404).json({ ok: false, error: '立场不存在或已删除' });
    res.json({ ok: true });
  }));

  // ---------- 立场抽取管线 (LLM) ----------
  router.post('/api/extract-stances', handleAsync(async (req, res) => {
    if (!llm) throw new Error('LLM 客户端未初始化');
    const { chatId, text, sourceMessageIds } = req.body ?? {};
    res.json({
      ok: true,
      ...(await extractStances(db, {
        llm, chatId, text,
        sourceMessageIds: sourceMessageIds ?? [],
      })),
    });
  }));

  // ---------- 遗忘衰减任务 ----------
  // 默认 dry-run 只扫描候选; confirm=true 才执行软遗忘
  router.post('/api/forget', handle((req, res) => {
    const { threshold, minAgeDays, protectImportance, confirm } = req.body ?? {};
    res.json({
      ok: true,
      ...runForgetTask(db, {
        threshold: threshold !== undefined ? Number(threshold) : FORGET_SCORING.defaults.threshold,
        minAgeDays: minAgeDays !== undefined ? Number(minAgeDays) : FORGET_SCORING.defaults.minAgeDays,
        protectImportance: protectImportance !== undefined ? Number(protectImportance) : FORGET_SCORING.defaults.protectImportance,
        confirm: confirm === true,
      }),
    });
  }));

  // 遗忘可逆: 恢复软遗忘的条目
  router.post('/api/forget/restore', handle((req, res) => {
    const { table, id } = req.body ?? {};
    if (!table || !id) throw new Error('table/id 必填');
    const done = restoreForgotten(db, { table, id: Number(id) });
    if (!done) return res.status(404).json({ ok: false, error: '条目不存在或未被遗忘' });
    res.json({ ok: true });
  }));

  return router;
}
