@echo off
REM Power Outages launcher
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
if not exist .env (
  echo Creating .env from .env.example - put your Google Client ID there if you want sign-in.
  copy /y .env.example .env >nul
)
echo Starting Power Outages on http://localhost:4950 ...
start "" http://localhost:4950
node --env-file-if-exists=.env server.js
