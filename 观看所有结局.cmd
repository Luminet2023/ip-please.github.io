@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PLAYWRIGHT_MODULE=%TEMP%\ip-please-browser-deps\node_modules\playwright"
node -e "try{require('playwright')}catch(e){require(process.env.PLAYWRIGHT_MODULE)}" >nul 2>nul
if errorlevel 1 call npm install --no-save --package-lock=false playwright
if errorlevel 1 exit /b 1
node tools\browser_all_endings.js %*
pause
