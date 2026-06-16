@echo off
REM ============================================================
REM  Douyin Monitor - Debug Mode Start (with GC + verbose log)
REM ============================================================

chcp 65001 >nul 2>&1

cd /d "%~dp0"

echo.
echo ============================================================
echo   Douyin Monitor v2.0 - Debug Mode
echo ============================================================
echo.

if not exist "node_modules" (
    echo First run, installing dependencies...
    call npm install
    if errorlevel 1 goto :install_failed
)

echo GC enabled, memory watchdog active.
echo Press Ctrl+C to stop.
echo.

set NODE_OPTIONS=--expose-gc
call npx electron . --enable-logging

goto :end

:install_failed
echo ERROR: npm install failed
echo Try: npm install --registry=https://registry.npmmirror.com
pause
exit /b 1

:end
echo.
echo App exited.
pause >nul
exit /b 0
