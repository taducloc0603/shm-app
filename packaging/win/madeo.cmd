@echo off
rem Doc file .ticks/.trace cua TradeDesktop (Madeo).
rem Dac ta tung truong: docs/tradedesktop-binary-format.md
rem   madeo.cmd info "<file.trace>"
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\ShmHub.exe" "%~dp0tools\madeo.mjs" %*
