@echo off
rem Doc file .gtick tren may da cai app, khong can cai Node rieng:
rem ShmHub.exe chay o che do Node chinh la Node.
rem   ticks.cmd stats "%USERPROFILE%\Desktop\ticks\<file>.gtick"
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\ShmHub.exe" "%~dp0tools\ticks.mjs" %*
