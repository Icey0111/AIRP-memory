@echo off
rem ===== TavernMemory: install autostart (hidden background service) =====
rem Known-good node (v22, matches better-sqlite3 ABI). Change here if needed.
set "NODEEXE=C://Users//20436//.workbuddy//binaries//node//versions//22.22.2-6//node.exe"
"%NODEEXE%" "%~dp0server\autostart-install.mjs"
pause
