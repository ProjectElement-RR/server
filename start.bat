@echo off
echo Starting Resurge Server on main port 2056 ^(WS 2059, CDN 2058^)...
echo.
cd /d "%~dp0"
node --max-old-space-size=2048 index.js
pause
