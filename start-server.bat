@echo off
rem ===== TavernMemory: start service (minimized window, ASCII-only on purpose) =====
rem Known-good node (v22, matches better-sqlite3 ABI). Change here if needed.
set "NODEEXE=C:\Users\20436\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
cd /d "%~dp0server"
start "TavernMemory" /min cmd /c """%NODEEXE%"" src\index.js"
echo Memory service started (minimized in taskbar).
echo The panel will auto-connect within 10 seconds.
timeout /t 3 >nul
