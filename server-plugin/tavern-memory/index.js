// SillyTavern / TauriTavern 服务器插件: 随酒馆自动拉起/停止记忆服务
//
// 效果: 装上它, 酒馆启动 => 记忆服务自动在后台启动 (隐藏窗口, 无终端);
//       酒馆关闭 => 记忆服务一起停止。用户全程零操作, 这是最终的免终端形态。
//
// 安装 (三步):
//   1. 把整个 tavern-memory 文件夹复制到酒馆根目录的 plugins/ 下
//      (标准 ST: <SillyTavern>/plugins/tavern-memory)
//   2. 改本文件顶部的 SERVER_DIR 为记忆服务所在目录 (server/ 的绝对路径)
//   3. config.yaml 开启 enableServerPlugins: true, 重启酒馆
//
// 原理: 插件本身零依赖 —— 它只用酒馆自带的 node 把 server/src/index.js
//       作为子进程拉起 (记忆服务自己的 node_modules 在它自己的目录里, 互不污染)。
//       不用子进程内联跑的原因: 记忆服务是 ESM + 自带依赖树, 内联需要把
//       better-sqlite3 等原生模块装进酒馆的 node_modules, 侵入性大得多。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ====== 按需修改: 记忆服务的 server 目录绝对路径 ======
// 也可以用环境变量 TM_SERVER_DIR 覆盖 (不用改本文件)
let SERVER_DIR = 'E:\\记忆系统\\server';
if (process.env.TM_SERVER_DIR) SERVER_DIR = process.env.TM_SERVER_DIR;
// =====================================================

let child = null;

async function init() {
  const entry = path.join(SERVER_DIR, 'src', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`[tavern-memory] 找不到记忆服务入口: ${entry} —— 请修改本文件顶部的 SERVER_DIR`);
    return;
  }
  // 酒馆自己就是 node 进程, process.execPath 就是可用的 node
  child = spawn(process.execPath, [entry], {
    cwd: SERVER_DIR,
    stdio: 'ignore',          // 隐藏后台运行; 服务日志要看就去 server/data 看 retrieval_log
    windowsHide: true,
  });
  child.on('error', (err) => console.error(`[tavern-memory] 记忆服务启动失败: ${err.message}`));
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[tavern-memory] 记忆服务异常退出 (code=${code}), 通常是端口被占用: 已有一个实例在跑`);
    child = null;
  });
  console.log(`[tavern-memory] 记忆服务已随酒馆启动 (node ${entry})`);
}

async function exit() {
  if (child) {
    child.kill();
    child = null;
    console.log('[tavern-memory] 记忆服务已随酒馆停止');
  }
}

module.exports = {
  init,
  exit,
  info: {
    id: 'tavern-memory',
    name: 'TavernMemory 启动器',
    description: '随酒馆自动启动/停止 AIRP 记忆服务 (server/src/index.js)',
  },
};
