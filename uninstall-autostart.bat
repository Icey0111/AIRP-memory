@echo off
rem ===== TavernMemory: remove autostart =====
set "NODEEXE=C://Users//20436//.workbuddy//binaries//node//versions//22.22.2-6//node.exe"
"%NODEEXE%" "%~dp0server\autostart-install.mjs" --remove
pause
