@echo off
REM Power Outages launcher
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
echo Starting Power Outages on http://localhost:4950 ...
start "" http://localhost:4950
node server.js
