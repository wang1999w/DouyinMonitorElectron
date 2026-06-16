@echo off
REM ============================================================
REM  Douyin Monitor - Windows One-Click Start
REM  Run: double-click start.bat  OR  .\start.bat in PowerShell
REM ============================================================

chcp 65001 >nul 2>&1

cd /d "%~dp0"

echo.
echo ============================================================
echo   Douyin Monitor v2.0 - Starting
echo ============================================================
echo.

REM ---- 1. Check Node.js ----
echo [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "tokens=1" %%v in ('node -v') do set NODE_VER=%%v
echo       OK Node %NODE_VER%

REM ---- 2. Check npm ----
echo [2/5] Checking npm...
where npm >nul 2>&1
if errorlevel 1 goto :no_npm
for /f "tokens=1" %%v in ('npm -v') do set NPM_VER=%%v
echo       OK npm %NPM_VER%

REM ---- 3. Install dependencies ----
echo [3/5] Checking dependencies...
if not exist "node_modules" goto :install_deps
echo       OK dependencies installed
goto :deps_ok

:install_deps
echo       First run, installing dependencies (may take 2-5 min)...
call npm install
if errorlevel 1 goto :install_failed
goto :deps_ok

:deps_ok

REM ---- 4. Prepare directories ----
echo [4/5] Preparing directories...
if not exist "logs" mkdir logs
if not exist "exports" mkdir exports
if not exist "logs\.gitkeep" copy /y nul "logs\.gitkeep" >nul
if not exist "exports\.gitkeep" copy /y nul "exports\.gitkeep" >nul
echo       OK directories ready

REM ---- 5. Launch application ----
echo [5/5] Launching Electron app...
echo.
echo ============================================================
echo   App starting... first launch opens Douyin login page
echo   HTTP control panel: http://127.0.0.1:18911
echo   Close window to exit, or press Ctrl+C
echo ============================================================
echo.

call npm start

echo.
echo App exited.
goto :end

:no_node
echo       ERROR: Node.js not found
echo       Please install Node.js 18+: https://nodejs.org/
pause
exit /b 1

:no_npm
echo       ERROR: npm not found
pause
exit /b 1

:install_failed
echo       ERROR: npm install failed
echo       Try: npm install --registry=https://registry.npmmirror.com
pause
exit /b 1

:end
echo Press any key to close...
pause >nul
exit /b 0
