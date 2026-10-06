@echo off
rem Start the DSH mobile bridge (LAN reverse proxy). Keep this window open while using the phone.
setlocal
set "BRIDGE=%~dp0bridge.cjs"
where node >nul 2>nul || (echo [x] node not found. Install Node.js first. & pause & exit /b 1)
echo [*] starting DSH mobile bridge ...
node "%BRIDGE%" %*
echo.
echo [*] bridge exited. Press any key to close.
pause >nul
