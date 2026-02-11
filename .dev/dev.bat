@echo off
REM Sutu Development Scripts
REM Usage: dev.bat [command] or double-click for menu

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

REM If no argument, show interactive menu
if "%1"=="" goto menu

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

:menu
cls
echo.
echo   ============================================
echo        Sutu Development Menu
echo   ============================================
echo.
echo   [1] dev            Start development server
echo   [2] build          Build project (debug)
echo   [3] build-release  Build project (release)
echo   [4] install        Install dependencies
echo   [5] test           Run all tests
echo   [6] check          Run all checks
echo   [7] lint           Run linters
echo   [8] format         Format code
echo   [9] clean          Clean build artifacts
echo   [0] exit           Exit
echo.
set /p choice="  Enter choice [1-9, 0 to exit]: "

if "%choice%"=="1" goto dev
if "%choice%"=="2" goto build
if "%choice%"=="3" goto build_release
if "%choice%"=="4" goto install
if "%choice%"=="5" goto test
if "%choice%"=="6" goto check
if "%choice%"=="7" goto lint
if "%choice%"=="8" goto format
if "%choice%"=="9" goto clean
if "%choice%"=="0" goto end
echo.
echo   Invalid choice, please try again.
timeout /t 2 >nul
goto menu

:install
echo.
echo [Sutu] Installing dependencies...
call pnpm install
if errorlevel 1 goto error
echo [Sutu] Dependencies installed successfully!
goto done

:dev
echo.
echo [Sutu] Starting development server...
call pnpm tauri dev
goto done

:build
echo.
echo [Sutu] Building project (debug)...
call pnpm run build:dev
if errorlevel 1 goto error
cd src-tauri
call cargo build
if errorlevel 1 goto error
echo [Sutu] Build completed!
goto done

:build_release
echo.
echo [Sutu] Building project (release)...
call pnpm run build:dev
if errorlevel 1 goto error
cd src-tauri
call cargo build --release
if errorlevel 1 goto error
echo [Sutu] Release build completed!
echo Output: src-tauri\target\release\
goto done

:test
echo.
echo [Sutu] Running tests...
call pnpm test
if errorlevel 1 goto error
cd src-tauri
call cargo test
if errorlevel 1 goto error
echo [Sutu] All tests passed!
goto done

:check
echo.
echo [Sutu] Running all checks...
call pnpm typecheck
if errorlevel 1 goto error
call pnpm lint
if errorlevel 1 goto error
cd src-tauri
call cargo clippy -- -D warnings
if errorlevel 1 goto error
call cargo test
if errorlevel 1 goto error
cd ..
call pnpm test
if errorlevel 1 goto error
echo [Sutu] All checks passed!
goto done

:lint
echo.
echo [Sutu] Running linters...
call pnpm lint
cd src-tauri
call cargo clippy -- -D warnings
goto done

:format
echo.
echo [Sutu] Formatting code...
call pnpm format
goto done

:clean
echo.
echo [Sutu] Cleaning build artifacts...
if exist node_modules rmdir /s /q node_modules
if exist dist rmdir /s /q dist
cd src-tauri
if exist target rmdir /s /q target
echo [Sutu] Cleaned!
goto done

:help
echo.
echo  Sutu Development Scripts
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
goto done

:error
echo.
echo [Sutu] ERROR: Command failed!
goto done

:done
echo.
pause
goto end

:end
endlocal
