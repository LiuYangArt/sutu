@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo ========================================
echo   Sutu Dev Environment Setup
echo ========================================
echo.

:: Check if pnpm is available
where pnpm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] pnpm not found!
    echo Please install pnpm first:
    echo   npm install -g pnpm
    echo   or
    echo   iwr https://get.pnpm.io/install.ps1 -useb ^| iex
    pause
    exit /b 1
)

:: Check if Rust is available (for Tauri)
where cargo >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] Rust/Cargo not found!
    echo Tauri backend requires Rust. Install from: https://rustup.rs/
    echo.
)

echo [1/2] Installing dependencies...
call pnpm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] pnpm install failed!
    pause
    exit /b 1
)

echo.
echo [2/2] Starting dev server...
echo.
echo ========================================
echo   Dev server starting...
echo   Frontend: http://localhost:1420
echo   Press Ctrl+C to stop
echo ========================================
echo.

call pnpm dev
