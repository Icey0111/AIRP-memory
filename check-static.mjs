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

console.log('');
console.log('HTML 中的 id:');
console.log('  ' + [...htmlIds].sort().join(', '));
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
