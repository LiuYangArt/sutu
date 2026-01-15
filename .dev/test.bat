@echo off
REM PaintBoard Test Runner
REM Usage: test.bat [command] or double-click for menu

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

REM If no argument, show interactive menu
if "%1"=="" goto menu

if "%1"=="unit" goto unit
if "%1"=="e2e" goto e2e
if "%1"=="visual" goto visual
if "%1"=="all" goto all
goto help

:menu
cls
echo.
echo   ============================================
echo        PaintBoard Test Runner
echo   ============================================
echo.
echo   [1] unit           Run unit tests (Vitest)
echo   [2] e2e            Run E2E tests (Playwright)
echo   [3] visual         Open GPU/CPU comparison page
echo   [4] all            Run all automated tests
echo   [5] e2e:flicker    Run flicker stress tests
echo   [6] e2e:headed     Run E2E with browser visible
echo   [0] exit           Exit
echo.
set /p choice="  Enter choice [1-6, 0 to exit]: "

if "%choice%"=="1" goto unit
if "%choice%"=="2" goto e2e
if "%choice%"=="3" goto visual
if "%choice%"=="4" goto all
if "%choice%"=="5" goto e2e_flicker
if "%choice%"=="6" goto e2e_headed
if "%choice%"=="0" goto end
echo.
echo   Invalid choice, please try again.
timeout /t 2 >nul
goto menu

:unit
echo.
echo [Test] Running unit tests (Vitest)...
call pnpm test
if errorlevel 1 goto error
echo [Test] Unit tests passed!
goto done

:e2e
echo.
echo [Test] Running E2E tests (Playwright)...
echo [Test] Starting dev server in background...
start /b cmd /c "pnpm dev"
timeout /t 5 >nul
call pnpm exec playwright test
taskkill /f /im node.exe >nul 2>&1
if errorlevel 1 goto error
echo [Test] E2E tests passed!
goto done

:e2e_flicker
echo.
echo [Test] Running flicker stress tests...
echo [Test] Starting dev server in background...
start /b cmd /c "pnpm dev"
timeout /t 5 >nul
call pnpm exec playwright test e2e/stroke-flicker.spec.ts --headed
taskkill /f /im node.exe >nul 2>&1
if errorlevel 1 goto error
echo [Test] Flicker tests completed!
goto done

:e2e_headed
echo.
echo [Test] Running E2E tests with browser visible...
echo [Test] Starting dev server in background...
start /b cmd /c "pnpm dev"
timeout /t 5 >nul
call pnpm exec playwright test --headed
taskkill /f /im node.exe >nul 2>&1
if errorlevel 1 goto error
echo [Test] E2E tests passed!
goto done

:visual
echo.
echo [Test] Opening GPU/CPU comparison test page...
echo [Test] Starting dev server...
start /b cmd /c "pnpm dev"
timeout /t 3 >nul
start "" "http://localhost:5173/tests/visual/gpu-cpu-comparison.html"
echo.
echo [Test] Test page opened in browser.
echo [Test] Press any key to stop the dev server...
pause >nul
taskkill /f /im node.exe >nul 2>&1
goto end

:all
echo.
echo [Test] Running all automated tests...
echo.
echo [Test] Step 1/3: Unit tests (Vitest)...
call pnpm test
if errorlevel 1 goto error
echo.
echo [Test] Step 2/3: E2E tests (Playwright)...
start /b cmd /c "pnpm dev"
timeout /t 5 >nul
call pnpm exec playwright test
set E2E_RESULT=%errorlevel%
taskkill /f /im node.exe >nul 2>&1
if %E2E_RESULT% neq 0 goto error
echo.
echo [Test] Step 3/3: Rust tests...
cd src-tauri
call cargo test
if errorlevel 1 goto error
cd ..
echo.
echo ============================================
echo   All tests passed!
echo ============================================
goto done

:help
echo.
echo  PaintBoard Test Runner
echo  ======================
echo.
echo  Usage: test.bat [command]
echo.
echo  Commands:
echo    unit         Run unit tests (Vitest)
echo    e2e          Run E2E tests (Playwright, headless)
echo    visual       Open GPU/CPU comparison test page
echo    all          Run all automated tests
echo.
goto done

:error
echo.
echo [Test] ERROR: Tests failed!
goto done

:done
echo.
pause
goto end

:end
endlocal
