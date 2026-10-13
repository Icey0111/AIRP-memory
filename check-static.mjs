// 一次性静态一致性检查: settings.html 的 id 与 src/ui.js 的选择器/步骤开关是否对得上
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, 'settings.html'), 'utf-8');
const ui = fs.readFileSync(path.join(dir, 'src', 'ui.js'), 'utf-8');
const extractor = fs.readFileSync(path.join(dir, 'src', 'extractor.js'), 'utf-8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const refs = new Set();
for (const m of ui.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]);
for (const m of ui.matchAll(/querySelector\(\s*'#([A-Za-z0-9_]+)'\s*\)/g)) refs.add(m[1]);
for (const m of ui.matchAll(/sel:\s*'#([A-Za-z0-9_]+)'/g)) refs.add(m[1]);

const DYN = 'tm_step_';
const missing = [...refs].filter((id) => !htmlIds.has(id) && !id.startsWith(DYN));
const unused = [...htmlIds].filter((id) => !refs.has(id) && !id.startsWith(DYN));

let fail = 0;
const say = (ok, msg) => { console.log(`${ok ? '  OK  ' : '  FAIL'} ${msg}`); if (!ok) fail++; };

say(missing.length === 0, `ui.js 引用的 ${refs.size} 个静态 id 均存在于 settings.html${missing.length ? ` — 缺失: ${missing.join(', ')}` : ''}`);
say(unused.length === 0, `settings.html 无未被引用的冗余 id${unused.length ? ` — 冗余: ${unused.join(', ')}` : ''}`);

const keys = [...html.matchAll(/data-tm-default="([^"]+)"/g)].map((m) => m[1]);
say(ui.includes("getAttribute('data-tm-default')"), `ui.js 处理了 data-tm-default (${keys.join(', ')})`);
say(htmlIds.has('tm_step_switches'), '步骤开关容器 #tm_step_switches 存在');
say(ui.includes("'tm_step_switches'"), 'ui.js 引用了步骤开关容器');
say(extractor.includes('export const STEP_LIST'), 'extractor.js 导出了 STEP_LIST');
say(ui.includes('STEP_LIST'), 'ui.js 使用 STEP_LIST 生成步骤开关');

// settings.js 的字段 key 必须覆盖 HTML 里绑定的所有字段
const settingsSrc = fs.readFileSync(path.join(dir, 'src', 'settings.js'), 'utf-8');
const fieldKeys = [...ui.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
const missingKeys = fieldKeys.filter((k) => !new RegExp(`\\b${k}:`).test(settingsSrc));
say(fieldKeys.length > 0 && missingKeys.length === 0,
  `ui.js 绑定的 ${fieldKeys.length} 个字段都在 DEFAULT_SETTINGS 里有默认值${missingKeys.length ? ` — 缺失: ${missingKeys.join(', ')}` : ''}`);

// 步骤开关的 setting 名也必须在 DEFAULT_SETTINGS 里
const stepSettings = [...extractor.matchAll(/setting:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
const missingStep = stepSettings.filter((k) => !new RegExp(`\\b${k}:`).test(settingsSrc));
say(stepSettings.length > 0 && missingStep.length === 0,
  `STEP_LIST 的 ${stepSettings.length} 个 setting 都在 DEFAULT_SETTINGS 里${missingStep.length ? ` — 缺失: ${missingStep.join(', ')}` : ''}`);

// ---------- 反向: DEFAULT_SETTINGS 的每个键都必须能在面板上调整 ----------
// 加字段时忘了绑 UI, 老配置会带上一个用户永远改不了的键 —— 这里直接钉死
const dsMatch = settingsSrc.match(/export const DEFAULT_SETTINGS\s*=\s*\{([\s\S]*?)\n\};/);
const dsKeys = dsMatch ? [...dsMatch[1].matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]) : [];
const boundKeys = new Set([...fieldKeys, ...stepSettings]);
const unbound = dsKeys.filter((k) => !boundKeys.has(k));
say(dsKeys.length > 0, `从 settings.js 解析出 DEFAULT_SETTINGS 的 ${dsKeys.length} 个键`);
say(unbound.length === 0,
  `每个持久化字段都能在面板上调整 (共绑定 ${boundKeys.size} 个)${unbound.length ? ` — 无 UI 入口: ${unbound.join(', ')}` : ''}`);

// ---------- 对酒馆模块的相对导入路径 ----------
// 扩展的 HTTP 挂载点固定为 /scripts/extensions/third-party/<扩展目录>/ , 与磁盘安装位置无关。
// 因此对酒馆模块的相对导入必须**刚好**解析到 /script.js 或 /scripts/extensions.js:
// 文件每深一层就要多一层 '../' —— src/ 下的文件比 index.js 深一层, 最容易漏写, 一漏就整包加载失败。
const MOUNT = ['scripts', 'extensions', 'third-party', 'AIRP-memory'];
const EXT_MODULES = new Set(['/script.js', '/scripts/extensions.js']);
const jsFiles = ['index.js', ...fs.readdirSync(path.join(dir, 'src'))
  .filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)];
const importIssues = [];
let importCount = 0;
for (const rel of jsFiles) {
  const src = fs.readFileSync(path.join(dir, rel), 'utf-8');
  const dirname = path.dirname(rel);
  const subdirs = dirname === '.' ? [] : dirname.split('/');
  for (const m of src.matchAll(/from\s+'((?:\.\.\/)+)([A-Za-z0-9_]+\.js)'/g)) {
    importCount++;
    const levels = m[1].split('/').filter(Boolean).length;
    const segs = [...MOUNT, ...subdirs];
    const resolved = `/${[...segs.slice(0, segs.length - levels), m[2]].join('/')}`;
    if (!EXT_MODULES.has(resolved)) importIssues.push(`${rel}: ${m[0]} → ${resolved}`);
  }
}
say(importCount > 0, `扫描到 ${importCount} 条对酒馆模块的相对导入`);
say(importIssues.length === 0,
  `导入路径全部解析到 /script.js 或 /scripts/extensions.js${importIssues.length ? ` — 错误: ${importIssues.join(' | ')}` : ''}`);

console.log('');
console.log('HTML 中的 id:');
console.log('  ' + [...htmlIds].sort().join(', '));
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
