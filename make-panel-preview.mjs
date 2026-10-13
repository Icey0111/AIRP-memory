// 生成面板预览页: docs/panel-preview.html
//
// 把 settings.html 片段 + style.css 组装成一个可独立打开的页面, 并填充一份"假数据"
// (已连接的服务状态), 用来在浏览器里直接看面板排版与折叠交互, 不需要酒馆、不需要后端。
//
// 预览页里的交互是 ui.js 的同语义简化版, **不落盘** —— 真实折叠状态由扩展存在
// extension_settings.tavernMemory.uiCollapsed 里。
//
// 用法: node make-panel-preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'settings.html'), 'utf-8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf-8');

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆系统 · 设置面板预览</title>
<style>
/* --- 模拟酒馆主题变量与控件外观 (仅为预览, 真实环境由酒馆提供) --- */
:root {
  --SmartThemeBorderColor: rgba(255, 255, 255, 0.22);
  --SmartThemeQuoteColor: #79b8ff;
  --white20a: rgba(255, 255, 255, 0.07);
  --white30a: rgba(255, 255, 255, 0.14);
}
body {
  margin: 0;
  padding: 20px;
  background: #1a1c20;
  color: #dcdcdc;
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 15px;
}
.preview-wrap { width: 430px; max-width: 100%; }
.preview-note {
  border: 1px dashed rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 14px;
  font-size: 0.85em;
  line-height: 1.6;
  opacity: 0.8;
}
.text_pole {
  background: #0f1114;
  color: #e8e8e8;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  padding: 3px 6px;
  font: inherit;
}
.menu_button {
  background: #2a2d33;
  color: #e8e8e8;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  cursor: pointer;
}
.menu_button:disabled { opacity: 0.45; cursor: not-allowed; }
.checkbox_label { display: flex; align-items: center; gap: 6px; margin: 3px 0; cursor: pointer; }
input[type=checkbox] { accent-color: #79b8ff; }
.inline-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}
.inline-drawer-icon { opacity: 0.6; }
${css}
</style>
</head>
<body>
<div class="preview-wrap">
  <div class="preview-note">
    <b>面板预览</b>（离线）—— 排版与折叠交互与扩展内一致，数据是假的。<br>
    反复点模块标题可折叠/展开；「展开全部 / 收起全部」在面板顶部。<br>
    真实环境里折叠状态会记进酒馆设置，下次打开保持原样。
  </div>
${html}
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 填一份"已连接"的假数据, 只为看排版 ----------
  var banner = $('tm_banner');
  banner.className = 'tm-banner tm-banner-ok';
  banner.textContent = '已连接 tavern-memory v0.1.0 · schema 5/5';

  $('tm_enabled').checked = true;
  $('tm_base_url').value = 'http://127.0.0.1:7780';
  $('tm_timeout').value = '15000';

  $('tm_inject_enabled').checked = true;
  $('tm_inject_position').value = 'in_prompt';
  $('tm_inject_depth').value = '4';
  $('tm_inject_role').value = 'system';
  $('tm_topk').value = '0';
  $('tm_token_budget').value = '0';
  $('tm_query_messages').value = '1';
  $('tm_query_max_chars').value = '500';

  $('tm_auto_write').checked = false;
  $('tm_auto_every').value = '10';
  $('tm_write_count').value = '10';
  $('tm_write_max_chars').value = '4000';

  Array.prototype.forEach.call(document.querySelectorAll('[data-tm-default]'), function (el) {
    el.textContent = el.getAttribute('data-tm-default') === 'retrieval.topK'
      ? '服务端默认 8' : '服务端默认 1200';
  });

  var steps = [
    ['six', '六要素抽取', 'POST /api/extract', true],
    ['attrs', '属性观察', 'POST /api/extract-attributes', true],
    ['stances', '立场抽取', 'POST /api/extract-stances', true],
    ['derive', '画像重归纳', 'POST /api/profiles-derive', false]
  ];
  $('tm_step_switches').innerHTML = steps.map(function (s) {
    return '<label class="checkbox_label" for="tm_step_' + s[0] + '">'
      + '<input id="tm_step_' + s[0] + '" type="checkbox"' + (s[3] ? '' : ' disabled') + '>'
      + '<span>' + s[1] + ' <code>' + s[2] + '</code> '
      + '<span class="tm-badge ' + (s[3] ? 'tm-badge-ok' : 'tm-badge-blocked') + '">'
      + (s[3] ? '可用' : '契约未载入') + '</span></span></label>';
  }).join('');
  steps.forEach(function (s) { var el = $('tm_step_' + s[0]); if (el) el.checked = s[3]; });

  $('tm_conn_detail').innerHTML =
    '<dl class="tm-dl">'
    + '<dt>服务</dt><dd>tavern-memory v0.1.0</dd>'
    + '<dt>schema</dt><dd>5 / 最高支持 5</dd>'
    + '<dt>LLM</dt><dd><span class="tm-ok">可用</span> openai-compatible · gpt-4o-mini · 60000ms</dd>'
    + '<dt>embedding</dt><dd><span class="tm-ok">可用</span> openai-compatible · bge-m3 · 1024 维</dd>'
    + '<dt>绑定 / 鉴权</dt><dd>127.0.0.1:7780 · 鉴权 无</dd>'
    + '<dt>表行数</dt><dd>memories 128 · attribute_chunks 342 · stances 51</dd>'
    + '</dl>';

  $('tm_cap_table').innerHTML =
    '<table class="tm-table"><thead><tr><th>端点</th><th>依赖</th><th>状态</th><th>降级</th></tr></thead><tbody>'
    + '<tr><td class="tm-mono">POST /api/context</td><td>—</td><td><span class="tm-badge tm-badge-ok">可用</span></td><td><span class="tm-badge tm-badge-silent">静默降级</span></td></tr>'
    + '<tr><td class="tm-mono">POST /api/extract</td><td>LLM</td><td><span class="tm-badge tm-badge-ok">可用</span></td><td><span class="tm-badge tm-badge-error">报错</span></td></tr>'
    + '<tr><td class="tm-mono">POST /api/extract-attributes</td><td>LLM + embedding</td><td><span class="tm-badge tm-badge-ok">可用</span></td><td><span class="tm-badge tm-badge-error">报错</span></td></tr>'
    + '<tr><td class="tm-mono">POST /api/profiles-derive</td><td>LLM</td><td><span class="tm-badge tm-badge-blocked">LLM 未配置</span></td><td><span class="tm-badge tm-badge-error">报错</span></td></tr>'
    + '</tbody></table>';

  $('tm_contract').innerHTML =
    '<div class="tm-muted">以下均为服务端 /api/meta 原文，前端不重写</div>'
    + '<dl class="tm-dl">'
    + '<dt>检索打分</dt><dd>score = 0.6 × 相关性 + 0.25 × importance + 0.15 × 时间新近度</dd>'
    + '<dt>supersede 阈值</dt><dd>0.85（cosine）</dd>'
    + '<dt>遗忘打分</dt><dd>score = 0.5 × importance + 0.3 × 时间新近度 + 0.2 × 访问频率</dd>'
    + '<dt>可见性</dt><dd>global 全局可见 · character 仅同角色卡 · chat 仅当前会话</dd>'
    + '</dl>';

  $('tm_status').textContent = '最近一次注入：3 条记忆 + 2 条细节 · 用 412 / 1200 token · 33ms';
  $('tm_preview_result').innerHTML =
    '<div class="tm-muted">query: 艾拉为什么会离开北境的哨塔</div>'
    + '<div>注入文本 412/1200 token · 画像 2 · 记忆 3 · 细节 2</div>'
    + '<div class="tm-subsection-title">记忆命中（FTS）</div>'
    + '<table class="tm-table"><thead><tr><th>类型</th><th>score</th><th>内容</th></tr></thead><tbody>'
    + '<tr><td class="tm-nowrap">事件</td><td class="tm-nowrap tm-mono">0.812</td><td>艾拉在雪夜离开哨塔，未留下字条</td></tr>'
    + '<tr><td class="tm-nowrap">事实</td><td class="tm-nowrap tm-mono">0.744</td><td>哨塔位于北境边境，常年积雪</td></tr>'
    + '</tbody></table>';

  // ---------- 模块摘要 ----------
  $('tm_tag_connection').textContent = '已连接 v0.1.0';
  $('tm_tag_inject').textContent = '开';
  $('tm_tag_write').textContent = '关';
  $('tm_tag_diagnostics').textContent = '16/17 端点可用';

  // ---------- 折叠交互 (与 ui.js 同语义, 但预览不落盘) ----------
  var MODULE_KEYS = ['connection', 'inject', 'write', 'manual', 'diagnostics'];
  var state = { write: true, manual: true, diagnostics: true };

  function moduleEl(key) { return document.querySelector('[data-tm-module="' + key + '"]'); }

  function applyAll() {
    MODULE_KEYS.forEach(function (key) {
      var el = moduleEl(key);
      if (!el) return;
      var collapsed = state[key] === true;
      el.classList.toggle('tm-collapsed', collapsed);
      var head = el.querySelector('.tm-module-head');
      if (head) head.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  applyAll();

  MODULE_KEYS.forEach(function (key) {
    var el = moduleEl(key);
    var head = el && el.querySelector('.tm-module-head');
    if (!head) return;
    head.addEventListener('click', function () {
      state[key] = !el.classList.contains('tm-collapsed');
      applyAll();
    });
  });

  $('tm_expand_all').addEventListener('click', function () {
    MODULE_KEYS.forEach(function (k) { state[k] = false; });
    applyAll();
  });
  $('tm_collapse_all').addEventListener('click', function () {
    MODULE_KEYS.forEach(function (k) { state[k] = true; });
    applyAll();
  });
})();
</script>
</body>
</html>
`;

const outPath = path.join(root, 'docs', 'panel-preview.html');
fs.writeFileSync(outPath, page);
console.log(`已生成预览: ${outPath}`);
console.log(`  来源: settings.html + style.css (改完面板后可重新生成)`);
