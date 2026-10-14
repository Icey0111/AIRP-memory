@echo off
rem ===== AIRP mode on the dsh DESKTOP app =====
rem 1) sync profiles from repo (dsh\airp-preset.patch.yml is the single source of truth)
rem 2) start the memory service (127.0.0.1:7780)
rem 3) open the desktop app -- then pick the "AIRP 角色扮演" preset for the session
rem Vanilla stays vanilla: the default preset is still 标准模式, nothing global is added.
set "NODEEXE=C:\Users\20436\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "DSHAPP=C:\Users\20436\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"

rem --- 1) sync profile composition from repo ---
"%NODEEXE%" "%~dp0dsh\sync-profiles.mjs"

rem --- 2) memory service ---
cd /d "%~dp0server"
start "AIRP-Memory" /min cmd /c """%NODEEXE%"" src\index.js"
echo Memory service starting (minimized). MCP tools appear once it listens on 7780.

rem --- 3) desktop app ---
timeout /t 2 >nul
start "" "%DSHAPP%"

rem --- 4) memory graph window (watch the network grow while you play) ---
timeout /t 2 >nul
start "" "http://127.0.0.1:7780/graph"
