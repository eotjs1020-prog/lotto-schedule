@echo off
setlocal

cd /d "%~dp0"

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm.cmd not found. Please install Node.js.
  pause
  exit /b 1
)

echo [1/3] npm install
call npm.cmd install
if errorlevel 1 goto :error

echo [2/3] npm run setup
call npm.cmd run setup
if errorlevel 1 goto :error

echo [3/3] npm start
call npm.cmd start
if errorlevel 1 goto :error

goto :end

:error
echo Error occurred while running bot.
pause
exit /b 1

:end
endlocal
