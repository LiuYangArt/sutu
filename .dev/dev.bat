@echo off
REM PaintBoard Development Scripts
REM Usage: dev.bat [command]

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

if "%1"=="" goto help
if "%1"=="install" goto install
if "%1"=="dev" goto dev
if "%1"=="build" goto build
if "%1"=="build-release" goto build_release
if "%1"=="test" goto test
if "%1"=="check" goto check
if "%1"=="lint" goto lint
if "%1"=="format" goto format
if "%1"=="clean" goto clean
goto help

:install
echo [PaintBoard] Installing dependencies...
call pnpm install
if errorlevel 1 exit /b 1
echo [PaintBoard] Dependencies installed successfully!
goto end

:dev
echo [PaintBoard] Starting development server...
call pnpm tauri dev
goto end

:build
echo [PaintBoard] Building project (debug)...
call pnpm build:dev
if errorlevel 1 exit /b 1
cd src-tauri
call cargo build
if errorlevel 1 exit /b 1
echo [PaintBoard] Build completed!
goto end

:build_release
echo [PaintBoard] Building project (release)...
call pnpm build:dev
if errorlevel 1 exit /b 1
cd src-tauri
call cargo build --release
if errorlevel 1 exit /b 1
echo [PaintBoard] Release build completed!
echo Output: src-tauri\target\release\
goto end

:test
echo [PaintBoard] Running tests...
call pnpm test
if errorlevel 1 exit /b 1
cd src-tauri
call cargo test
if errorlevel 1 exit /b 1
echo [PaintBoard] All tests passed!
goto end

:check
echo [PaintBoard] Running all checks...
call pnpm typecheck
if errorlevel 1 exit /b 1
call pnpm lint
if errorlevel 1 exit /b 1
cd src-tauri
call cargo clippy -- -D warnings
if errorlevel 1 exit /b 1
call cargo test
if errorlevel 1 exit /b 1
cd ..
call pnpm test
if errorlevel 1 exit /b 1
echo [PaintBoard] All checks passed!
goto end

:lint
echo [PaintBoard] Running linters...
call pnpm lint
cd src-tauri
call cargo clippy -- -D warnings
goto end

:format
echo [PaintBoard] Formatting code...
call pnpm format
goto end

:clean
echo [PaintBoard] Cleaning build artifacts...
if exist node_modules rmdir /s /q node_modules
if exist dist rmdir /s /q dist
cd src-tauri
if exist target rmdir /s /q target
echo [PaintBoard] Cleaned!
goto end

:help
echo.
echo  PaintBoard Development Scripts
echo  ==============================
echo.
echo  Usage: dev.bat [command]
echo.
echo  Commands:
echo    install        Install all dependencies (pnpm + cargo)
echo    dev            Start development server with hot reload
echo    build          Build project (debug mode)
echo    build-release  Build project (release mode, optimized)
echo    test           Run all tests (frontend + Rust)
echo    check          Run all checks (typecheck, lint, test)
echo    lint           Run linters only
echo    format         Format all code
echo    clean          Remove all build artifacts
echo.
goto end

:end
endlocal
