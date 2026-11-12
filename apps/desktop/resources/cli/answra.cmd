@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Answra.exe" "%~dp0resources\cli\main.cjs" %*
exit /b %ERRORLEVEL%
