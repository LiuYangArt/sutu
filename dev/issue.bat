@echo off
REM Sutu Issue Automation Helper
REM Usage: issue.bat [command] or double-click for menu

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"
set "INTERACTIVE=0"

if "%1"=="" (
  set "INTERACTIVE=1"
  goto menu
)

if /i "%1"=="today" goto today
if /i "%1"=="triage-readonly" goto triage_readonly_safe
if /i "%1"=="triage-incremental" goto triage_incremental_run
if /i "%1"=="triage-full" goto triage_full_run
if /i "%1"=="workflow-incremental" goto workflow_incremental
if /i "%1"=="workflow-full" goto workflow_full
if /i "%1"=="workflow-retry" goto workflow_retry
if /i "%1"=="vars" goto vars
if /i "%1"=="auth" goto auth
goto help

:menu
cls
echo.
echo   ============================================
echo        Sutu Issue Automation Menu
echo   ============================================
echo.
echo   [1] today                 Show today's priorities (pnpm task:today)
echo   [2] triage-readonly       Local safe triage (readonly, no git push)
echo   [3] triage-incremental    Local incremental triage (mutates issues)
echo   [4] triage-full           Local full triage (mutates issues)
echo   [5] workflow-incremental  Trigger GitHub Action incremental mode
echo   [6] workflow-full         Trigger GitHub Action full mode
echo   [7] workflow-retry        Trigger GitHub Action retry mode
echo   [8] vars                  Show required GitHub variables/secrets
echo   [9] auth                  Check gh authentication and repo
echo   [0] exit                  Exit
echo.
set /p choice="  Enter choice [1-9, 0 to exit]: "

if "%choice%"=="1" goto today
if "%choice%"=="2" goto triage_readonly_safe
if "%choice%"=="3" goto triage_incremental_run
if "%choice%"=="4" goto triage_full_run
if "%choice%"=="5" goto workflow_incremental
if "%choice%"=="6" goto workflow_full
if "%choice%"=="7" goto workflow_retry
if "%choice%"=="8" goto vars
if "%choice%"=="9" goto auth
if "%choice%"=="0" goto end

echo.
echo   Invalid choice, please try again.
timeout /t 2 >nul
goto menu

:ensure_tools
where pnpm >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Issue Ops] ERROR: pnpm not found in PATH.
  goto done
)

where gh >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Issue Ops] ERROR: gh not found in PATH.
  goto done
)
goto :eof

:today
call :ensure_tools
echo.
echo [Issue Ops] Running daily priority report...
call pnpm task:today
if errorlevel 1 goto error
goto done

:triage_readonly_safe
call :ensure_tools
echo.
echo [Issue Ops] Running local safe triage...
echo [Issue Ops] Mode=full, readonly=true, skip_git=true
set "ISSUE_TRIAGE_MODE=full"
set "ISSUE_TRIAGE_READONLY=true"
set "ISSUE_TRIAGE_SKIP_GIT=true"
call node scripts/issue-triage.mjs
if errorlevel 1 goto error
goto done

:triage_incremental_run
call :ensure_tools
echo.
echo [Issue Ops] WARNING: this command can modify GitHub issue labels/comments.
choice /M "Continue with local incremental triage"
if errorlevel 2 goto menu
echo.
set "ISSUE_TRIAGE_MODE=incremental"
set "ISSUE_TRIAGE_READONLY=false"
set "ISSUE_TRIAGE_SKIP_GIT=true"
call node scripts/issue-triage.mjs
if errorlevel 1 goto error
goto done

:triage_full_run
call :ensure_tools
echo.
echo [Issue Ops] WARNING: this command can modify GitHub issue labels/comments.
choice /M "Continue with local full triage"
if errorlevel 2 goto menu
echo.
set "ISSUE_TRIAGE_MODE=full"
set "ISSUE_TRIAGE_READONLY=false"
set "ISSUE_TRIAGE_SKIP_GIT=true"
call node scripts/issue-triage.mjs
if errorlevel 1 goto error
goto done

:workflow_incremental
call :ensure_tools
echo.
echo [Issue Ops] Triggering workflow: issue-triage.yml (incremental)
call gh workflow run issue-triage.yml -f mode=incremental
if errorlevel 1 goto error
call :show_runs
goto done

:workflow_full
call :ensure_tools
echo.
echo [Issue Ops] Triggering workflow: issue-triage.yml (full)
call gh workflow run issue-triage.yml -f mode=full
if errorlevel 1 goto error
call :show_runs
goto done

:workflow_retry
call :ensure_tools
echo.
echo [Issue Ops] Triggering workflow: issue-triage.yml (retry)
call gh workflow run issue-triage.yml -f mode=retry
if errorlevel 1 goto error
call :show_runs
goto done

:show_runs
echo.
echo [Issue Ops] Latest runs:
call gh run list --workflow issue-triage.yml --limit 5
goto :eof

:vars
echo.
echo [Issue Ops] Required GitHub Settings (Repository Secrets/Variables):
echo.
echo   Secrets:
echo     - RELEASE_NOTES_API_KEY  (or OPENAI_API_KEY)
echo.
echo   Variables:
echo     - RELEASE_NOTES_MODEL
echo     - RELEASE_NOTES_API_BASE_URL
echo     - RELEASE_NOTES_API_PATH
echo.
echo   Optional Variables:
echo     - ISSUE_TRIAGE_DRY_RUN_CLOSE=true/false
echo     - ISSUE_LOOKBACK_HOURS=8
echo     - ISSUE_AI_TIMEOUT_MS=30000
echo     - ISSUE_AI_RETRY_DELAYS_MS=30000,120000,480000
echo     - ISSUE_DUPLICATE_CONFIDENCE=0.92
echo     - ISSUE_DUPLICATE_SIMILARITY=0.78
goto done

:auth
call :ensure_tools
echo.
echo [Issue Ops] gh auth status:
call gh auth status
echo.
echo [Issue Ops] current repository:
call gh repo view --json nameWithOwner,defaultBranchRef,url
goto done

:help
echo.
echo  Sutu Issue Automation Helper
echo  ============================
echo.
echo  Usage: dev\issue.bat [command]
echo.
echo  Commands:
echo    today                 Show today's priorities
echo    triage-readonly       Local safe triage (readonly, no push)
echo    triage-incremental    Local incremental triage (mutates issues)
echo    triage-full           Local full triage (mutates issues)
echo    workflow-incremental  Trigger GitHub Actions triage incremental
echo    workflow-full         Trigger GitHub Actions triage full
echo    workflow-retry        Trigger GitHub Actions triage retry
echo    vars                  Show required variables and secrets
echo    auth                  Check gh auth and repo
echo.
goto done

:error
echo.
echo [Issue Ops] ERROR: Command failed!
goto done

:done
echo.
if "%INTERACTIVE%"=="1" pause
goto end

:end
endlocal
