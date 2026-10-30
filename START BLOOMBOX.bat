@echo off
setlocal
cd /d "%~dp0"
cls
echo ==========================================
echo          BLOOMBOX - EASY START
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18 or newer from https://nodejs.org/
  echo Then close this window and double-click this file again.
  echo.
  pause
  exit /b 1
)
echo Node found:
node --version
echo.
if not exist "server.js" (
  echo ERROR: server.js is missing from this folder.
  echo Please extract ALL files from the ZIP first, then double-click this file.
  echo.
  pause
  exit /b 1
)
if not exist "index.html" (
  echo ERROR: index.html is missing from this folder.
  echo Please extract ALL files from the ZIP first, then double-click this file.
  echo.
  pause
  exit /b 1
)
echo Starting BloomBox. Keep this window open.
echo Opening http://localhost:3000 in your browser...
echo To stop the app, press Ctrl+C in this window.
echo.
start "BloomBox browser" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
