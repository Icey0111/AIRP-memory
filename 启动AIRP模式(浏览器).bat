@echo off
rem ===== AIRP mode, browser variant (fully isolated profile=airp) =====
rem Use this when you want the memory system in its own profile, never sharing
rem anything with the desktop app. Default preset in this profile IS airp-roleplay.
set "NODEEXE=C:\Users\20436\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "DSHCMD=C:\Users\20436\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

"%NODEEXE%" "%~dp0dsh\sync-profiles.mjs"

cd /d "%~dp0server"
start "AIRP-Memory" /min cmd /c """%NODEEXE%"" src\index.js"
echo Memory service starting (minimized). Web UI opens once it listens on 7780.
timeout /t 2 >nul

call "%DSHCMD%" --profile airp
