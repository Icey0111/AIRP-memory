@echo off
chcp 65001 >nul
echo == TavernMemory: remove autostart ==
where node >nul 2>nul
if errorlevel 1 (
  echo [X] "node" not found in PATH.
  pause
  exit /b 1
)
node "%~dp0server\autostart-install.mjs" --remove
pause
