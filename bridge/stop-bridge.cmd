@echo off
rem Stop the DSH mobile bridge: end the scheduled task first (otherwise its
rem restart-on-failure would bring the bridge back), then kill whatever still
rem listens on the port. Usage: stop-bridge.cmd [port]   (default 8099)
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8099"
schtasks /End /TN "DSH Mobile Bridge" >nul 2>nul && echo [*] scheduled task ended
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  echo [*] killing PID %%p on port %PORT%
  taskkill /PID %%p /F >nul 2>nul
)
echo [*] done.
