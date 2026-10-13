// 写入闭环: 把最近若干条对话交给服务端抽取, 落成记忆
//
// 时序 (对应 docs/api.md §10): 四个端点相互独立, 共用同一段对话原文。
//   POST /api/extract             二阶六要素 (事件骨架)
//   POST /api/extract-attributes  三阶属性观察 (角色细节)
//   POST /api/extract-stances     立场演化 (关系变化)
//   POST /api/profiles-derive     画像重归纳 (依赖上一步拿到的人物 id)
//
// 降级原则: 任何一步失败都只跳过该步并记日志, 绝不影响对话与注入。
// 可用性判定: 完全依据服务端 /api/meta 声明的 needsLlm / needsEmbedding (metaStore.canCall)。
import { collectMessages, getChatId, getCharacterId } from './session.js';

/** 四个步骤的端点引用。路径是 API 结构 (非语义), 显示名与描述取自服务端 meta。 */
const STEP_DEFS = {
  six: { key: 'six', label: '六要素抽取', setting: 'writeSixElements', endpoint: { method: 'POST', path: '/api/extract' } },
  attrs: { key: 'attrs', label: '属性观察', setting: 'writeAttributes', endpoint: { method: 'POST', path: '/api/extract-attributes' } },
  stances: { key: 'stances', label: '立场抽取', setting: 'writeStances', endpoint: { method: 'POST', path: '/api/extract-stances' } },
  derive: { key: 'derive', label: '画像重归纳', setting: 'deriveProfile', endpoint: { method: 'POST', path: '/api/profiles-derive' } },
};

/** 步骤清单 (供 UI 渲染开关; 顺序即执行顺序, 画像归纳依赖六要素产出的人物 id) */
export const STEP_LIST = [STEP_DEFS.six, STEP_DEFS.attrs, STEP_DEFS.stances, STEP_DEFS.derive];

export function createExtractor({ api, metaStore, getSettings, log, bus }) {
  let sinceLast = 0;
  let running = false;
  let lastReport = null;

  function notify(phase) {
    if (bus) bus.emit({ type: 'write', phase, report: lastReport, running });
  }

  /**
   * 执行单个步骤: 先按服务端声明判定可用性, 再执行, 失败只记不抛。
   * producer 返回 { skip: '原因' } 表示"业务上无需执行"(非错误)。
   */
  async function step(report, def, producer) {
    const ep = metaStore.endpoint(def.endpoint.method, def.endpoint.path);
    const base = {
      key: def.key,
      label: def.label,
      path: def.endpoint.path,
      summary: ep?.summary ?? null,
      needsLlm: ep?.needsLlm ?? null,
      needsEmbedding: ep?.needsEmbedding ?? null,
    };

    const gate = metaStore.canCall(def.endpoint.method, def.endpoint.path);
    if (!gate.ok) {
      report.steps.push({ ...base, status: 'skipped', detail: gate.reason });
      log.debug(`跳过 ${def.label}: ${gate.reason}`);
      return;
    }

    try {
      const out = await producer();
      if (out && typeof out === 'object' && typeof out.skip === 'string') {
        report.steps.push({ ...base, status: 'skipped', detail: out.skip });
        return;
      }
      report.steps.push({ ...base, status: 'ok', detail: String(out ?? '') });
    } catch (err) {
      report.steps.push({ ...base, status: 'error', detail: err.message });
      report.errors.push(`${def.label}: ${err.message}`);
      // 静默降级: 只跳过写入, 不影响对话与注入
      log.warn(`写入步骤失败, 已跳过 (不影响对话): ${def.label} — ${err.message}`);
    }
  }

  /** 自动触发计数: 每收到一条角色消息计一次 */
  function noteMessage() {
    const s = getSettings();
    if (!s.enabled || !s.autoWriteEnabled) return;
    const every = Math.max(1, Number(s.autoWriteEveryNMessages) || 1);
    sinceLast += 1;
    if (sinceLast < every) {
      notify('tick');
      return;
    }
    sinceLast = 0;
    void run('auto');
  }

  function reset() {
    sinceLast = 0;
  }

  /**
   * 跑一轮写入。永不抛错 —— 调用方可能是事件回调。
   * @param {'manual'|'auto'} trigger
   */
  async function run(trigger = 'manual') {
    if (running) return { skipped: '已有写入任务在进行中', trigger };

    const s = getSettings();
    if (!s.enabled) return { skipped: '记忆系统已关闭', trigger };

    let collected;
    try {
      collected = collectMessages({ count: s.writeMessageCount, maxChars: s.writeMaxChars });
    } catch (err) {
      log.warn('读取对话失败:', err.message);
      return { error: `读取对话失败: ${err.message}`, trigger };
    }

    const { text, sourceMessageIds, messageCount } = collected;
    if (!text.trim()) return { skipped: '没有可抽取的对话文本', trigger };

    const report = {
      trigger,
      at: Date.now(),
      messageCount,
      sourceMessageIds,
      chatId: getChatId(),
      characterId: getCharacterId(),
      steps: [],
      errors: [],
      people: [],
      derivePersonId: null,
    };

    running = true;
    lastReport = report;
    notify('start');

    try {
      // 抽取类请求耗时取决于 LLM, fetch 超时按服务端下发的 LLM 超时推算, 不在前端写死
      const llmTimeoutMs = metaStore.llmRequestTimeoutMs();
      const opts = llmTimeoutMs === null ? undefined : { timeoutMs: llmTimeoutMs };
      const { chatId, characterId } = report;
      const label = (enumName, value) => metaStore.label(enumName, value);

      if (s[STEP_DEFS.six.setting]) {
        await step(report, STEP_DEFS.six, async () => {
          const r = await api.extract({ chatId, text, sourceMessageIds }, opts);
          report.people = Array.isArray(r.people) ? r.people : [];
          const parts = [
            `${label('entityType', 'person')} ${report.people.length}`,
            `${label('entityType', 'location')} ${r.locations?.length ?? 0}`,
            `${label('memoryType', 'event')} ${r.events?.length ?? 0}`,
            `因果边 ${r.links?.length ?? 0}`,
          ];
          if (r.timePoint?.label) parts.push(`时间点「${r.timePoint.label}」`);
          if (r.memoryIds?.length) parts.push(`落库记忆 ${r.memoryIds.length} 条`);
          return parts.join(' / ');
        });
      }

      if (s[STEP_DEFS.attrs.setting]) {
        await step(report, STEP_DEFS.attrs, async () => {
          const r = await api.extractAttributes({ chatId, text, sourceMessageIds }, opts);
          const skipped = Number(r.skipped) || 0;
          const chunks = Array.isArray(r.chunks) ? r.chunks : [];
          // V8: 三种结构操作分开报 —— "又看到一次"与"值真的变了"不是一回事,
          // 合成一个"新增 N 条"会让人以为同一条观察被记了很多遍。
          // 操作名与标签一律取自服务端契约 (slotOperation), 前端不写这组字面量。
          const parts = (metaStore.getEnumOptions('slotOperation') ?? [])
            .map((o) => {
              const n = chunks.filter((c) => c.operation === o.value).length;
              return n ? `${o.label} ${n}` : null;
            })
            .filter(Boolean);
          return `观察 ${chunks.length} 条${parts.length ? `: ${parts.join(' / ')}` : ''}`
            + `${skipped ? ` (跳过 ${skipped} 条不支持的实体类型)` : ''}`;
        });
      }

      if (s[STEP_DEFS.stances.setting]) {
        await step(report, STEP_DEFS.stances, async () => {
          const r = await api.extractStances({ chatId, text, sourceMessageIds }, opts);
          const list = (r.stances ?? [])
            .map((x) => `${x.holder?.name ?? '?'}→${x.target?.name ?? '?'} ${x.stanceType}${x.supersedes ? ' (演化)' : ''}`)
            .join(', ');
          const skipped = Number(r.skipped) || 0;
          return `${r.stances?.length ?? 0} 条${list ? `: ${list}` : ''}${skipped ? ` (跳过自指 ${skipped})` : ''}`;
        });
      }

      if (s[STEP_DEFS.derive.setting]) {
        await step(report, STEP_DEFS.derive, async () => {
          // profiles-derive 的 characterId 是角色卡名, personId 必须是 people 表整数 id。
          // 只有本轮的六要素结果能给出这个映射 —— 拿不到就如实跳过, 不猜 id。
          const target = report.people.find((p) => p?.name === characterId);
          if (!target) {
            return { skip: `本轮抽取出的人物里没有当前角色卡「${characterId}」, 无对应 personId, 跳过归纳` };
          }
          report.derivePersonId = target.id;
          const r = await api.deriveProfile({ personId: target.id, characterId }, opts);
          if (!Number(r.chunkCount)) {
            return { skip: `人物「${characterId}」(id=${target.id}) 暂无生效观察块, 服务端短路返回空` };
          }
          return `画像条目 ${r.entries?.length ?? 0} 条 / 依据观察块 ${r.chunkCount} 条`;
        });
      }
    } catch (err) {
      // 兜底: 任何未预期异常都不许冒泡到事件回调
      report.errors.push(`未预期异常: ${err.message}`);
      log.error('写入流程异常', err);
    } finally {
      running = false;
      notify('done');
    }

    if (report.errors.length) log.warn('写入完成, 有失败步骤:', report.errors.join(' | '));
    else log.debug('写入完成', report.steps);
    return report;
  }

  return {
    run,
    noteMessage,
    reset,
    getLast: () => lastReport,
    isRunning: () => running,
    getPendingCount: () => sinceLast,
  };
}
