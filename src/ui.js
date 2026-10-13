// 设置面板: 渲染 + 绑定
//
// 硬性约定: 后端语义 (枚举项与标签、默认值、公式、阈值、规则文案、端点可用性)
// 一律从 metaStore 取并原样渲染。契约未载入时显示"未载入"并禁用依赖项,
// 绝不退回本地硬编码的枚举或默认值。
import { getSettings, saveSettings, resetSettings } from './settings.js';
import { STEP_LIST } from './extractor.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(kind, msg) {
  const t = globalThis.toastr;
  if (t && typeof t[kind] === 'function') t[kind](msg, '记忆系统');
  else console[kind === 'error' ? 'error' : 'log'](`[记忆系统] ${msg}`);
}

// 面板上的标量字段: DOM <-> settings 双向绑定
const FIELDS = [
  { sel: '#tm_enabled', key: 'enabled', type: 'bool' },
  { sel: '#tm_base_url', key: 'baseUrl', type: 'str', evt: 'change', after: 'reloadMeta' },
  { sel: '#tm_timeout', key: 'requestTimeoutMs', type: 'int', min: 1000 },

  { sel: '#tm_inject_enabled', key: 'injectEnabled', type: 'bool' },
  { sel: '#tm_inject_position', key: 'injectPosition', type: 'str' },
  { sel: '#tm_inject_depth', key: 'injectDepth', type: 'int' },
  { sel: '#tm_inject_role', key: 'injectRole', type: 'str' },
  { sel: '#tm_topk', key: 'retrievalTopK', type: 'int' },
  { sel: '#tm_token_budget', key: 'retrievalTokenBudget', type: 'int' },
  { sel: '#tm_query_messages', key: 'queryMessages', type: 'int' },
  { sel: '#tm_query_max_chars', key: 'queryMaxChars', type: 'int' },

  { sel: '#tm_auto_write', key: 'autoWriteEnabled', type: 'bool' },
  { sel: '#tm_auto_every', key: 'autoWriteEveryNMessages', type: 'int' },
  { sel: '#tm_write_count', key: 'writeMessageCount', type: 'int' },
  { sel: '#tm_write_max_chars', key: 'writeMaxChars', type: 'int' },

  { sel: '#tm_summary_enabled', key: 'summaryEnabled', type: 'bool' },
  { sel: '#tm_summary_trigger', key: 'summaryTriggerTokens', type: 'int' },
  // -1 表示"用服务端建议", 所以下限是 -1 而不是 0
  { sel: '#tm_summary_keep', key: 'summaryKeepRecentMessages', type: 'int', min: -1 },
  { sel: '#tm_summary_hide', key: 'summaryHideAfter', type: 'bool' },

  { sel: '#tm_debug', key: 'debugLog', type: 'bool' },
];

// 面板模块, 与 settings.html 里的 data-tm-module 一一对应; 顺序即显示顺序
const MODULE_KEYS = ['connection', 'inject', 'write', 'summary', 'manual', 'diagnostics'];

export function mountPanel({ metaStore, injector, extractor, summarizer, log, bus }) {
  const root = document.getElementById('tavern_memory_panel');
  if (!root) {
    console.error('[记忆系统] 未找到面板节点 #tavern_memory_panel, 设置面板载入失败');
    return;
  }

  let lastMeta = null;
  let lastInjectOutcome = null;
  let lastWriteReport = null;
  let lastSummaryReport = null;
  let lastPreview = null;

  // ---------- 步骤开关 (由 STEP_LIST 生成, 可用性取自 meta) ----------
  function buildStepSwitches() {
    const s = getSettings();
    const loaded = metaStore.isLoaded();
    const html = STEP_LIST.map((def) => {
      const ep = metaStore.endpoint(def.endpoint.method, def.endpoint.path);
      const gate = loaded
        ? metaStore.canCall(def.endpoint.method, def.endpoint.path)
        : { ok: false, reason: '契约未载入' };
      const badge = !loaded
        ? '<span class="tm-badge tm-badge-unknown">契约未载入</span>'
        : (gate.ok
          ? '<span class="tm-badge tm-badge-ok">可用</span>'
          : `<span class="tm-badge tm-badge-blocked">${esc(gate.reason)}</span>`);
      const title = ep?.summary ? esc(ep.summary) : esc(def.endpoint.path);
      return `<label class="checkbox_label" for="tm_step_${esc(def.key)}" title="${title}">
        <input id="tm_step_${esc(def.key)}" type="checkbox"${gate.ok ? '' : ' disabled'}>
        <span>${esc(def.label)} <code>${esc(def.endpoint.method)} ${esc(def.endpoint.path)}</code> ${badge}</span>
      </label>`;
    }).join('');
    document.getElementById('tm_step_switches').innerHTML = html;
    for (const def of STEP_LIST) {
      const el = document.getElementById(`tm_step_${def.key}`);
      if (el) el.checked = Boolean(s[def.setting]);
    }
  }

  // ---------- 标量字段绑定 ----------
  function loadFields() {
    const s = getSettings();
    for (const f of FIELDS) {
      const el = document.querySelector(f.sel);
      if (!el) continue;
      if (f.type === 'bool') el.checked = Boolean(s[f.key]);
      else el.value = s[f.key];
    }
  }

  function bindFields() {
    for (const f of FIELDS) {
      const el = document.querySelector(f.sel);
      if (!el) continue;
      const evt = f.evt ?? ((f.type === 'bool' || el.tagName === 'SELECT') ? 'change' : 'input');
      el.addEventListener(evt, () => {
        const s = getSettings();
        if (f.type === 'bool') s[f.key] = el.checked;
        else if (f.type === 'int') {
          // 输入框被清空时不覆盖已存值, 免得"删掉重打"的中间态被当成 0 存下去
          if (el.value === '') return;
          s[f.key] = Math.max(f.min ?? 0, Math.trunc(Number(el.value) || 0));
        } else s[f.key] = el.value;
        saveSettings();
        renderModuleTags();
        if (f.after === 'reloadMeta') void reloadMeta();
      });
    }

    // 步骤开关是动态生成的, 用事件委托
    document.getElementById('tm_step_switches').addEventListener('change', (e) => {
      const input = e.target;
      if (!input || input.type !== 'checkbox') return;
      const key = String(input.id).replace('tm_step_', '');
      const def = STEP_LIST.find((d) => d.key === key);
      if (!def) return;
      getSettings()[def.setting] = input.checked;
      saveSettings();
    });
  }

  // ---------- 渲染: 连接 ----------
  function renderConnection() {
    const snap = metaStore.snapshot();
    const banner = document.getElementById('tm_banner');
    const detail = document.getElementById('tm_conn_detail');

    if (!snap.loaded) {
      banner.className = 'tm-banner tm-banner-warn';
      banner.textContent = snap.lastError
        ? `未连接记忆服务：${snap.lastError}`
        : '未连接记忆服务';
      detail.innerHTML = '<span class="tm-muted">未载入契约 —— 下列选项需连接后由服务端下发</span>';
      return;
    }

    const m = snap.meta;
    const st = snap.status;
    banner.className = 'tm-banner tm-banner-ok';
    banner.textContent = `已连接 ${m.service} v${m.version ?? '?'} · schema ${m.schemaVersion}/${m.latestSupported}`;

    const caps = m.capabilities ?? {};
    const capLine = (c) => {
      if (!c) return '未声明';
      if (c.available) {
        const extra = [c.model, c.dim ? `dim=${c.dim}` : null, c.timeoutMs ? `${c.timeoutMs}ms` : null]
          .filter(Boolean).join(' · ');
        return `<span class="tm-ok">可用</span> ${esc(c.provider ?? '')}${extra ? ` · ${esc(extra)}` : ''}`;
      }
      return `<span class="tm-blocked">不可用</span> ${esc(c.reason ?? '')}`;
    };

    const counts = st?.counts ?? {};
    const rows = [
      ['服务', `${esc(m.service)} v${esc(m.version ?? '?')}`],
      ['schema', `${esc(m.schemaVersion)} / 最高支持 ${esc(m.latestSupported)}`],
      ['LLM', capLine(caps.llm)],
      ['embedding', capLine(caps.embedding)],
      ['向量检索', caps.vectorSearch
        ? (caps.vectorSearch.available
          ? `可用 · ${esc(caps.vectorSearch.metric)} · ${esc(caps.vectorSearch.strategy)}${caps.vectorSearch.approximate ? ' (近似)' : ''}`
          : `<span class="tm-blocked">不可用</span> ${esc(caps.vectorSearch.reason ?? '')}`)
        : '未声明'],
      ['存储', caps.storage
        ? `${esc(caps.storage.kind)} · ${esc(caps.storage.fts)} · 软删除 ${caps.storage.softDelete ? '开' : '关'}`
        : '未声明'],
      ['绑定 / 鉴权', `${esc(m.limits?.boundTo ?? '?')} · 鉴权 ${m.limits?.auth ? '有' : '无'}`],
      ['CORS', m.cors
        ? `开关 ${m.cors.enabled ? '开' : '关'} · 放行本机任意端口 ${m.cors.allowLoopbackAnyPort ? '是' : '否'}${m.cors.extraOrigins?.length ? ` · 白名单 ${esc(m.cors.extraOrigins.join(', '))}` : ''}`
        : '未声明'],
      ['表行数', Object.keys(counts).length
        ? Object.entries(counts).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')
        : '—'],
    ];
    detail.innerHTML = `<dl class="tm-dl">${rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  // ---------- 渲染: 端点能力表 ----------
  function renderCapabilityTable() {
    const el = document.getElementById('tm_cap_table');
    const m = metaStore.getMeta();
    if (!m) {
      el.innerHTML = '<span class="tm-muted">未载入契约</span>';
      return;
    }
    const eps = m.endpoints ?? [];
    const available = eps.filter((e) => metaStore.canCall(e.method, e.path).ok).length;

    const rows = eps.map((e) => {
      const gate = metaStore.canCall(e.method, e.path);
      const deps = [
        e.needsLlm ? 'LLM' : null,
        e.needsEmbedding ? 'embedding' : null,
      ].filter(Boolean).join(' + ') || '—';
      const status = gate.ok
        ? '<span class="tm-badge tm-badge-ok">可用</span>'
        : `<span class="tm-badge tm-badge-blocked" title="${esc(gate.reason ?? '')}">不可用</span>`;
      const degrade = e.degrade === 'silent'
        ? '<span class="tm-badge tm-badge-silent" title="' + esc(e.degradeNote ?? '') + '">静默降级</span>'
        : '<span class="tm-badge tm-badge-error" title="' + esc(e.degradeNote ?? '') + '">报错</span>';
      return `<tr>
        <td class="tm-mono">${esc(e.method)} ${esc(e.path)}</td>
        <td>${esc(e.summary ?? '')}</td>
        <td class="tm-nowrap">${esc(deps)}</td>
        <td class="tm-nowrap">${status}</td>
        <td class="tm-nowrap">${degrade}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="tm-muted">${available} / ${eps.length} 个端点当前可用</div>
      <table class="tm-table">
        <thead><tr><th>端点</th><th>说明</th><th>依赖</th><th>状态</th><th>依赖缺失时</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ---------- 渲染: 契约说明 ----------
  function renderContract() {
    const el = document.getElementById('tm_contract');
    const m = metaStore.getMeta();
    if (!m) {
      el.innerHTML = '<span class="tm-muted">未载入契约</span>';
      return;
    }
    const sc = m.scoring ?? {};
    const th = m.thresholds ?? {};
    const rules = m.rules ?? {};
    const d = m.defaults ?? {};

    const enumsLine = (name) => {
      const opts = metaStore.getEnumOptions(name);
      if (!opts) return '未声明';
      const constrained = metaStore.getEnum(name)?.constrained ? '受约束' : '不受约束（仅建议值）';
      return `${constrained}：${opts.map((o) => `${esc(o.label)}(${esc(o.value)})`).join('、')}`;
    };

    const blocks = [
      ['检索打分', sc.retrieval ? `<div class="tm-mono">${esc(sc.retrieval.formula)}</div>
        <div class="tm-muted">${esc(sc.retrieval.relevanceFormula ?? '')}</div>
        <div class="tm-muted">${esc(sc.retrieval.recencyFormula ?? '')}</div>` : '未声明'],
      ['遗忘打分', sc.forget ? `<div class="tm-mono">${esc(sc.forget.formula)}</div>
        <div class="tm-mono tm-muted">${esc(sc.forget.noAccessFormula ?? '')}</div>
        <div class="tm-muted">${(sc.forget.protections ?? []).map(esc).join('；')}</div>` : '未声明'],
      ['防吃书阈值', `${esc(th.supersedeSimilarity)} (${esc(th.similarityMetric)}) —— ${esc(rules.supersede ?? '')}`],
      ['token 估算', sc.tokenEstimation ? `<span class="tm-mono">${esc(sc.tokenEstimation.formula)}</span> ${esc(sc.tokenEstimation.description ?? '')}` : '未声明'],
      ['注入顺序', (m.contextSections ?? []).length
        ? m.contextSections.map((x) => `${esc(x.order)}. ${esc(x.label)}（${esc(x.description)}）`).join(' → ')
        : '未声明'],
      ['可见性', esc(rules.visibility ?? '未声明')],
      ['当前生效口径', esc(rules.currentFilter ?? '未声明')],
      ['软删除', esc(rules.softDelete ?? '未声明')],
      ['立场演化', esc(rules.stanceEvolution ?? '未声明')],
      ['id 体系', esc(rules.entityIdDuality ?? '未声明')],
      ['恢复范围', esc(rules.forgetRestoreScope ?? '未声明')],
      ['记忆类型', enumsLine('memoryType')],
      ['作用域', enumsLine('memoryScope')],
      ['可切块实体', enumsLine('chunkableEntityType')],
      ['立场实体', enumsLine('stanceEntityType')],
      ['遗忘表', enumsLine('forgetTable')],
      ['默认值', `检索 topK ${esc(d.retrieval?.topK)} / 预算 ${esc(d.retrieval?.tokenBudget)}；`
        + `记忆 importance ${esc(d.memory?.importance)} scope ${esc(d.memory?.scope)}；`
        + `观察块 importance ${esc(d.chunk?.importance)}；`
        + `立场 intensity ${esc(d.stance?.intensity)}；`
        + `遗忘 threshold ${esc(d.forget?.threshold)} minAgeDays ${esc(d.forget?.minAgeDays)} protectImportance ${esc(d.forget?.protectImportance)}`],
    ];

    el.innerHTML = `<dl class="tm-dl">${blocks
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  // ---------- 渲染: 最近状态 ----------
  function renderStatus() {
    const el = document.getElementById('tm_status');
    const parts = [];

    // 最近一次注入
    if (lastInjectOutcome) {
      const o = lastInjectOutcome;
      const time = new Date(o.at ?? Date.now()).toLocaleTimeString();
      if (o.data) {
        const d = o.data;
        parts.push(`<div><b>注入</b> ${esc(time)} · 用 ${esc(d.usedTokens)}/${esc(d.tokenBudget)} token · `
          + `画像 ${esc(d.profileCount)} 条 · 记忆命中 ${esc(d.hitCount)} 条 · 细节命中 ${esc(d.chunkHitCount)} 条</div>`);
        parts.push(`<div class="tm-muted">query: ${esc(String(o.query ?? '').slice(0, 120))}</div>`);
      } else if (o.error) {
        parts.push(`<div><b>注入</b> <span class="tm-blocked">失败</span>：${esc(o.error)}（本轮不注入，对话不受影响）</div>`);
      } else if (o.skipped) {
        parts.push(`<div><b>注入</b> <span class="tm-muted">跳过：${esc(o.skipped)}</span></div>`);
      }
    } else {
      parts.push('<div class="tm-muted"><b>注入</b> 尚未触发（发一条消息后可见）</div>');
    }

    // 最近一次写入
    const r = lastWriteReport ?? extractor.getLast();
    if (r) {
      const time = new Date(r.at).toLocaleTimeString();
      const trig = r.trigger === 'auto' ? '自动' : '手动';
      parts.push(`<div><b>写入</b> ${esc(time)} · ${esc(trig)} · ${esc(r.messageCount)} 条消息`
        + ` · 楼层 ${esc((r.sourceMessageIds ?? []).join(','))}</div>`);
      if (r.steps?.length) {
        parts.push(`<table class="tm-table"><tbody>${r.steps.map((s) => `<tr>
          <td class="tm-mono tm-nowrap" title="${esc(s.summary ?? '')}">${esc(s.path)}</td>
          <td>${esc(s.label)}</td>
          <td class="tm-nowrap">${s.status === 'ok'
    ? '<span class="tm-badge tm-badge-ok">成功</span>'
    : s.status === 'skipped'
      ? '<span class="tm-badge tm-badge-silent">跳过</span>'
      : '<span class="tm-badge tm-badge-blocked">失败</span>'}</td>
          <td>${esc(s.detail ?? '')}</td>
        </tr>`).join('')}</tbody></table>`);
      }
    }
    if (lastInjectOutcome?.error || (r?.errors?.length)) {
      parts.push('<div class="tm-muted">失败均已静默降级：只跳过该次写入/注入，不影响对话。</div>');
    }
    if (extractor.isRunning()) parts.push('<div class="tm-muted">写入任务进行中…</div>');

    el.innerHTML = parts.join('');
  }

  // ---------- 渲染: 检索预览 ----------
  function renderPreview() {
    const el = document.getElementById('tm_preview_result');
    if (!lastPreview) { el.innerHTML = '—'; return; }
    if (lastPreview.error) {
      el.innerHTML = `<span class="tm-blocked">失败：${esc(lastPreview.error)}</span>`;
      return;
    }
    const { context, retrieve, query } = lastPreview;
    const hitRows = (retrieve?.hits ?? []).map((h) => `<tr>
      <td class="tm-nowrap">${esc(metaStore.label('memoryType', h.type))}</td>
      <td class="tm-nowrap tm-mono">${esc(Number(h.score ?? 0).toFixed(3))}</td>
      <td>${esc(h.content)}</td>
    </tr>`).join('');
    const chunkRows = (retrieve?.chunkHits ?? []).map((h) => `<tr>
      <td class="tm-nowrap tm-mono">${esc(h.aspect)}</td>
      <td class="tm-nowrap tm-mono">${esc(Number(h.similarity ?? 0).toFixed(3))}</td>
      <td>${esc(h.content)}</td>
    </tr>`).join('');

    el.innerHTML = `
      <div class="tm-muted">query: ${esc(query)}</div>
      <div>注入文本 ${esc(context?.usedTokens)}/${esc(context?.tokenBudget)} token ·
        画像 ${esc(context?.profileCount)} · 记忆 ${esc(context?.hitCount)} · 细节 ${esc(context?.chunkHitCount)}</div>
      ${hitRows ? `<div class="tm-subsection-title">记忆命中（FTS）</div>
        <table class="tm-table"><thead><tr><th>类型</th><th>score</th><th>内容</th></tr></thead><tbody>${hitRows}</tbody></table>` : ''}
      ${chunkRows ? `<div class="tm-subsection-title">细节命中（向量）</div>
        <table class="tm-table"><thead><tr><th>维度</th><th>相似度</th><th>内容</th></tr></thead><tbody>${chunkRows}</tbody></table>` : ''}
      ${!hitRows && !chunkRows ? '<div class="tm-muted">无命中</div>' : ''}`;
  }

  // ---------- 渲染: 默认值提示 (放到输入框占位里) ----------
  // data-tm-default 写的是 defaults 里的路径 (如 retrieval.topK / summary.triggerTokens),
  // 统一按路径取值, 新增字段不用再改这里。
  function renderDefaultHints() {
    const d = metaStore.getDefaults();
    const lookup = (path) => path.split('.').reduce((acc, k) => (acc == null ? null : acc[k]), d);
    for (const el of document.querySelectorAll('[data-tm-default]')) {
      const val = lookup(el.getAttribute('data-tm-default'));
      el.textContent = val === undefined || val === null ? '' : `服务端默认 ${val}`;
    }
    const topk = document.getElementById('tm_topk');
    const budget = document.getElementById('tm_token_budget');
    const trigger = document.getElementById('tm_summary_trigger');
    if (topk && d?.retrieval?.topK) topk.placeholder = `${d.retrieval.topK}（0=默认）`;
    if (budget && d?.retrieval?.tokenBudget) budget.placeholder = `${d.retrieval.tokenBudget}（0=默认）`;
    if (trigger && d?.summary?.triggerTokens) trigger.placeholder = `${d.summary.triggerTokens}（0=默认）`;
  }

  // ---------- 渲染: 总结与压缩 ----------
  // 阈值、上下限、理由、预设、token 系数全部原样取自服务端, 前端不重写说法。
  function renderSummary() {
    const policyEl = document.getElementById('tm_summary_policy');
    const stateEl = document.getElementById('tm_summary_state');
    const resultEl = document.getElementById('tm_summary_result');
    if (!policyEl || !stateEl || !resultEl) return;

    const p = metaStore.summaryPolicy();
    if (!p) {
      policyEl.innerHTML = '<span class="tm-muted">未载入契约 —— 触发阈值与长度上限需连接后由服务端下发</span>';
      stateEl.textContent = '—';
      renderSummaryResult(resultEl);
      return;
    }

    const st = summarizer.status();
    const presets = (p.presets ?? [])
      .map((x) => `${esc(x.contextSize)} → ${esc(x.triggerTokens)}（${esc(x.note)}）`).join('；');
    policyEl.innerHTML = `
      <div class="tm-mono">阈值 ${esc(st.triggerTokens ?? '?')} · 下限 ${esc(p.minTokens)} ·
        单批上限 ${esc(p.maxBatchTokens)} token · 摘要上限 ${esc(p.maxSummaryChars)} 字</div>
      <div class="tm-muted">量纲：${esc(metaStore.getScoring()?.tokenEstimation?.formula ?? '未声明')}</div>
      <div class="tm-muted">${esc(p.rationale ?? '')}</div>
      <div class="tm-muted">按上下文选择：${presets || '未声明'}</div>`;

    const over = st.tokens >= (st.triggerTokens ?? Infinity);
    stateEl.innerHTML = `待总结 <b class="${over ? 'tm-ok' : ''}">${esc(st.tokens)}</b> / ${esc(st.triggerTokens ?? '?')} token`
      + ` · ${esc(st.pendingMessages)} 条（楼层 ${esc(st.pendingFrom)}–${esc(st.lastMessageIndex)}）`
      + ` · 已总结至 ${esc(st.summarizedUpTo)} · 已隐藏 ${esc(st.hiddenCount)} 条`
      + (st.running ? ' · <span class="tm-muted">进行中…</span>' : '');

    renderSummaryResult(resultEl);
  }

  function renderSummaryResult(resultEl) {
    const r = lastSummaryReport ?? summarizer.getLast();
    if (!r) { resultEl.innerHTML = '—'; return; }
    if (r.error) {
      resultEl.innerHTML = `<span class="tm-blocked">总结失败（不影响对话）：${esc(r.error)}</span>`;
      return;
    }
    if (r.skipped) {
      resultEl.innerHTML = `<span class="tm-muted">未总结：${esc(r.skipped)}</span>`;
      return;
    }
    const hid = r.hidden;
    const hideLine = !r.hidden
      ? '未隐藏正文'
      : (hid.ok
        ? `已隐藏 ${esc(hid.count)} 条（${hid.via === 'slash' ? '酒馆命令' : '直接置位'}，楼层 ${esc(hid.from)}–${esc(hid.to)}）`
        : `<span class="tm-blocked">隐藏未生效：${esc(hid.reason ?? '')}</span>`);
    resultEl.innerHTML =
      `<div>楼层 ${esc(r.coveredFrom)}–${esc(r.coveredTo)}（${esc(r.messageCount)} 条 · 约 ${esc(r.inputTokens)} token）`
      + ` → 摘要记忆 #${esc(r.summaryMemoryId ?? '?')}`
      + `${r.deduped ? '（复用既有摘要）' : ''}${r.truncated ? '（已按上限截断）' : ''}</div>`
      + `<div class="tm-muted">${hideLine}</div>`;
  }

  // ---------- 模块折叠 (状态与其他偏好一起持久化) ----------
  function moduleEl(key) {
    return root.querySelector(`[data-tm-module="${key}"]`);
  }

  function applyCollapsed(el, collapsed) {
    el.classList.toggle('tm-collapsed', collapsed);
    el.querySelector('.tm-module-head')?.setAttribute('aria-expanded', String(!collapsed));
  }

  /** 把已保存的折叠状态应用到面板 (重置设置后也要重新应用) */
  function applyStoredCollapsed() {
    const saved = getSettings().uiCollapsed;
    const state = (saved && typeof saved === 'object') ? saved : {};
    for (const key of MODULE_KEYS) {
      const el = moduleEl(key);
      if (el) applyCollapsed(el, state[key] === true); // 未记录过的模块默认展开
    }
  }

  function setModuleCollapsed(key, collapsed) {
    const el = moduleEl(key);
    if (!el) return;
    applyCollapsed(el, collapsed);
    const s = getSettings();
    if (!s.uiCollapsed || typeof s.uiCollapsed !== 'object') s.uiCollapsed = {};
    s.uiCollapsed[key] = collapsed;
    saveSettings();
  }

  function setupModules() {
    applyStoredCollapsed();

    for (const key of MODULE_KEYS) {
      const el = moduleEl(key);
      const head = el?.querySelector('.tm-module-head');
      if (!head) continue;
      head.addEventListener('click', () => setModuleCollapsed(key, !el.classList.contains('tm-collapsed')));
      // 头部是 div[role=button], 补上键盘可达性
      head.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        head.click();
      });
    }

    document.getElementById('tm_expand_all')?.addEventListener('click', () => {
      for (const key of MODULE_KEYS) setModuleCollapsed(key, false);
    });
    document.getElementById('tm_collapse_all')?.addEventListener('click', () => {
      for (const key of MODULE_KEYS) setModuleCollapsed(key, true);
    });
  }

  /** 模块头的一行摘要 —— 收起状态下也能看到关键状态 */
  function renderModuleTags() {
    const s = getSettings();
    const snap = metaStore.snapshot();
    const set = (key, text) => {
      const el = document.getElementById(`tm_tag_${key}`);
      if (el) el.textContent = text ?? '';
    };

    set('connection', snap.loaded ? `已连接 v${snap.meta?.version ?? '?'}` : '未连接');
    set('inject', (s.enabled && s.injectEnabled) ? '开' : '关');
    set('write', s.autoWriteEnabled ? `自动 · 每 ${s.autoWriteEveryNMessages} 条` : '关');

    if (!s.summaryEnabled) {
      set('summary', '关');
    } else {
      const st = summarizer.status();
      const thr = st.triggerTokens;
      set('summary', thr ? `${st.tokens}/${thr} token · 隐藏 ${st.hiddenCount} 条` : '阈值未载入');
    }

    const eps = snap.meta?.endpoints ?? [];
    set('diagnostics', eps.length
      ? `${eps.filter((e) => metaStore.canCall(e.method, e.path).ok).length}/${eps.length} 端点可用`
      : '');
  }

  // ---------- 渲染: 全部 ----------
  function renderAll() {
    lastMeta = metaStore.getMeta();
    renderConnection();
    buildStepSwitches();
    loadFields();
    renderDefaultHints();
    renderCapabilityTable();
    renderContract();
    renderStatus();
    renderPreview();
    renderSummary();
    updateActionButtons();
    renderModuleTags();
  }

  /** 手动按钮的可用性依据 meta 的端点声明, 而不是前端自己判断能力 */
  function updateActionButtons() {
    const loaded = metaStore.isLoaded();
    const writeBtn = document.getElementById('tm_run_write');
    const previewBtn = document.getElementById('tm_run_preview');

    if (writeBtn) {
      const gates = STEP_LIST.map((d) => metaStore.canCall(d.endpoint.method, d.endpoint.path));
      const usable = loaded && gates.some((g) => g.ok);
      writeBtn.disabled = !usable;
      writeBtn.title = !loaded
        ? '契约未载入 (未连接记忆服务)'
        : (gates.some((g) => g.ok) ? '' : '所有写入端点当前都不可用, 请检查服务端 LLM / embedding 配置');
    }
    if (previewBtn) {
      previewBtn.disabled = !loaded;
      previewBtn.title = loaded ? '' : '契约未载入 (未连接记忆服务)';
    }

    // 总结按钮: 可用性同样只看服务端对 /api/summarize 的声明
    const sumBtn = document.getElementById('tm_run_summary');
    if (sumBtn) {
      const gate = metaStore.canCall('POST', '/api/summarize');
      sumBtn.disabled = !loaded || !gate.ok;
      sumBtn.title = !loaded
        ? '契约未载入 (未连接记忆服务)'
        : (gate.ok ? '不受阈值限制, 立即总结当前待总结区间' : gate.reason);
    }
    const clearBtn = document.getElementById('tm_clear_summary');
    if (clearBtn) {
      clearBtn.disabled = !loaded;
      clearBtn.title = loaded ? '清空本聊天的总结边界记录 (不删除已写入的摘要记忆)' : '契约未载入';
    }
    const unhideBtn = document.getElementById('tm_unhide');
    if (unhideBtn) {
      const st = summarizer.status();
      unhideBtn.disabled = st.hiddenCount <= 0;
      unhideBtn.title = st.hiddenCount <= 0 ? '当前没有已隐藏的正文' : `把已隐藏的 ${st.hiddenCount} 条放回 prompt`;
    }
  }

  // ---------- 异步动作 ----------
  async function reloadMeta() {
    const btn = document.getElementById('tm_reload_meta');
    if (btn) btn.disabled = true;
    try {
      const snap = await metaStore.refresh();
      renderAll();
      if (snap.loaded) toast('success', `契约已载入：schema ${snap.meta.schemaVersion}`);
      else toast('error', `契约载入失败：${snap.lastError ?? '未知错误'}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runWrite() {
    const btn = document.getElementById('tm_run_write');
    if (btn) btn.disabled = true;
    try {
      const report = await extractor.run('manual');
      lastWriteReport = report.at ? report : lastWriteReport;
      if (report.skipped) toast('warning', `未执行写入：${report.skipped}`);
      else if (report.error) toast('error', `写入失败：${report.error}`);
      else if (report.errors?.length) toast('warning', `写入完成，有 ${report.errors.length} 步失败（已跳过）`);
      else toast('success', '写入完成');
      renderStatus();
      updateActionButtons();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runPreview() {
    const btn = document.getElementById('tm_run_preview');
    const input = document.getElementById('tm_preview_query');
    if (btn) btn.disabled = true;
    try {
      lastPreview = await injector.preview(input?.value ?? '');
      renderPreview();
      if (lastPreview.error) toast('error', `检索失败：${lastPreview.error}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runSummary() {
    const btn = document.getElementById('tm_run_summary');
    if (btn) btn.disabled = true;
    try {
      const report = await summarizer.run('manual');
      lastSummaryReport = report;
      if (report.skipped) toast('warning', `未总结：${report.skipped}`);
      else if (report.error) toast('error', `总结失败：${report.error}`);
      else {
        const hid = report.hidden;
        const tail = hid?.ok ? `，已隐藏 ${hid.count} 条` : '';
        toast('success', `总结完成：楼层 ${report.coveredFrom}–${report.coveredTo}${tail}`);
      }
      renderSummary();
      updateActionButtons();
      renderModuleTags();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runUnhide() {
    const btn = document.getElementById('tm_unhide');
    if (btn) btn.disabled = true;
    try {
      const r = await summarizer.unhideAll();
      if (r.skipped) toast('warning', r.skipped);
      else if (r.ok) toast('success', `已取消隐藏 ${r.count} 条（楼层 ${r.from}–${r.to}）`);
      else toast('error', `取消隐藏失败：${r.reason ?? '未知原因'}`);
      renderSummary();
      updateActionButtons();
      renderModuleTags();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runClearSummary() {
    await summarizer.resetState();
    lastSummaryReport = null;
    toast('success', '本聊天的总结边界已重置（已写入的摘要记忆与隐藏状态未改动）');
    renderSummary();
    updateActionButtons();
    renderModuleTags();
  }

  // ---------- 装配 ----------
  buildStepSwitches();
  loadFields();
  bindFields();
  setupModules();
  renderAll();

  document.getElementById('tm_reload_meta')?.addEventListener('click', () => void reloadMeta());
  document.getElementById('tm_run_write')?.addEventListener('click', () => void runWrite());
  document.getElementById('tm_run_preview')?.addEventListener('click', () => void runPreview());
  document.getElementById('tm_run_summary')?.addEventListener('click', () => void runSummary());
  document.getElementById('tm_unhide')?.addEventListener('click', () => void runUnhide());
  document.getElementById('tm_clear_summary')?.addEventListener('click', () => void runClearSummary());
  document.getElementById('tm_reset')?.addEventListener('click', () => {
    resetSettings();
    loadFields();
    buildStepSwitches();
    renderDefaultHints();
    applyStoredCollapsed();
    renderModuleTags();
    toast('success', '前端设置已重置（服务端数据未改动）');
  });

  if (bus) {
    bus.subscribe((ev) => {
      if (ev?.type === 'meta') renderAll();
      else if (ev?.type === 'inject') { lastInjectOutcome = ev.outcome; renderStatus(); }
      else if (ev?.type === 'write') { lastWriteReport = ev.report; renderStatus(); }
      else if (ev?.type === 'summary') {
        if (ev.report) lastSummaryReport = ev.report;
        renderSummary();
        renderModuleTags();
        updateActionButtons();
      }
    });
  }

  log.debug('设置面板已挂载', { steps: STEP_LIST.length, fields: FIELDS.length });

  return { renderAll, reloadMeta, runWrite, runPreview };
}
