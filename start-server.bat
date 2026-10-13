@echo off
chcp 65001 >nul
rem == TavernMemory: 双击启动记忆服务 (最小化窗口, 可直接关掉本窗口) ==
rem
rem 若提示找不到 node: 把下面 NODEEXE 改成 TauriTavern 自带的 node.exe 完整路径,
rem 并把下面的 "node src\index.js" 改成 "%NODEEXE%" src\index.js
rem
cd /d "%~dp0server"
where node >nul 2>nul
if not errorlevel 1 (
  start "TavernMemory" /min cmd /c "node src\index.js"
  echo 已启动: 服务在任务栏最小化运行, 打开酒馆面板即可自动连接。
  timeout /t 2 >nul
  exit /b 0
)
echo [X] 系统没有 node 命令。
echo     TauriTavern 用户: 用它自带的 node.exe, 例如:
echo       "C:\Program Files\TauriTavern\resources\node.exe" "E:\记忆系统\server\src\index.js"
pause
