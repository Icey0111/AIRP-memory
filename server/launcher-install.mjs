// 生成「打开酒馆（含记忆服务）」启动器:
//   双击它 = 隐藏启动记忆服务 + 打开 TauriTavern, 一步到位。
// 用法: node launcher-install.mjs          生成/更新启动器 (写在仓库根目录)
//       node launcher-install.mjs --shortcut  额外在桌面创建快捷方式
// 卸载: 直接删掉生成的 .vbs / 快捷方式即可。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));   // server/
const REPO_ROOT = path.resolve(SERVER_DIR, '..');
const NODE_EXE = process.execPath;                                 // 用运行本安装器的 node
const TAURI_EXE = 'C:\\Users\\20436\\scoop\\apps\\TauriTavern\\current\\TauriTavern.exe';
const OUT = path.join(REPO_ROOT, '打开酒馆（含记忆服务）.vbs');

const q = (s) => `"${s}"`;
const vbs = [
  "' 打开酒馆 + 记忆服务 (由 server/launcher-install.mjs 生成, 可删除后重新生成)",
  'Set sh = CreateObject("WScript.Shell")',
  `sh.CurrentDirectory = ${q(SERVER_DIR)}`,
  // 记忆服务: 隐藏窗口 (样式 0), 不等待; 若服务已在跑, 新实例会因端口占用静默退出, 无副作用
  `sh.Run ${q(`${q(NODE_EXE)} ${q(path.join(SERVER_DIR, 'watch-tavern.mjs'))}`)}, 0, False`,
  'WScript.Sleep 800',
  `sh.Run ${q(q(TAURI_EXE))}, 1, False`,
  '',
].join('\r\n');

// UTF-16LE + BOM: WScript 才能正确解析含中文的路径
fs.writeFileSync(OUT, `\ufeff${vbs}`, { encoding: 'utf16le' });
console.log(`[OK] 启动器已生成: ${OUT}`);
console.log('     双击它 = 后台启动记忆服务 + 打开 TauriTavern (建议固定到任务栏/开始屏幕)');

if (process.argv.includes('--shortcut')) {
  const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop');
  console.log('[i] 桌面快捷方式请手动创建: 右键启动器 -> 发送到 -> 桌面快捷方式');
  console.log(`    (桌面路径参考: ${desktop})`);
}
