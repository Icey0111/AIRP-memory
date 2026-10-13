// TauriTavern 看门狗: 登录后随自启隐藏运行, 平时零存在感;
// 一旦检测到 TauriTavern.exe 启动, 自动把记忆服务拉起 (隐藏窗口)。
//
// 语义 (用户要求): **打开酒馆的时候服务才启动** —— 而不是登录就常驻。
//   - 每 3 秒探测一次 TauriTavern.exe 是否在运行 (tasklist, 毫秒级开销);
//   - 在运行且服务未启动 => 用当前 node 隐藏拉起 server/src/index.js;
//   - 服务一旦起来就保持运行 (酒馆关闭不杀服务 —— 重开酒馆零等待, 也避免
//     正在进行的注入/抽取被拦腰打断); 想停服务用任务管理器结束 node 进程。
//
// 自启方式不变: autostart-install.mjs 生成的登录启动项指向本脚本 (而非服务本体)。
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ENTRY = path.join(SERVER_DIR, 'src', 'index.js');
const TAVERN_EXE = 'TauriTavern.exe';          // 监视目标进程名 (所有安装位置通用)
const POLL_MS = 3000;

let serviceProc = null;

function tavernRunning() {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${TAVERN_EXE}" /NH`, { encoding: 'utf8', windowsHide: true });
    return String(out).toLowerCase().includes('tauritavern.exe');
  } catch {
    return false;
  }
}

async function serviceHealthy() {
  try {
    const res = await fetch('http://127.0.0.1:7780/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function startService() {
  serviceProc = spawn(process.execPath, [SERVICE_ENTRY], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
  serviceProc.on('exit', () => { serviceProc = null; });
  console.log(`[watch] TauriTavern 已启动 => 记忆服务已拉起 (pid ${serviceProc.pid})`);
}

console.log(`[watch] 看门狗运行中: 每 ${POLL_MS / 1000}s 检查 ${TAVERN_EXE}, 出现即自动启动记忆服务`);

setInterval(async () => {
  try {
    if (serviceProc) return;                       // 服务由本看门狗拉起且还活着
    if (!(await serviceHealthy())) {
      if (tavernRunning()) startService();
      return;
    }
    // 服务健康但不是本看门狗的孩子 (手动 start-server.bat / 上一轮残留): 不重复拉起
  } catch { /* 任何单轮探测失败都静默, 下轮再试 */ }
}, POLL_MS);
