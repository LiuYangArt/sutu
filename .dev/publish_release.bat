@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0.." || (
    echo [ERROR] Failed to switch to repo root.
    pause
    exit /b 1
)

node -e "const v = require('./package.json').version; const [ma, mi, pa] = v.split('.').map(Number); console.log('set CURRENT_VERSION=' + v); console.log('set NEXT_PATCH=' + ma + '.' + mi + '.' + (pa + 1)); console.log('set NEXT_MINOR=' + ma + '.' + (mi + 1) + '.0'); console.log('set NEXT_MAJOR=' + (ma + 1) + '.0.0');" > versions.bat
if errorlevel 1 (
    echo [ERROR] Failed to read version from package.json.
    pause
    exit /b 1
)

call versions.bat
if errorlevel 1 (
    echo [ERROR] Failed to parse version values.
    del versions.bat >nul 2>nul
    pause
    exit /b 1
)
del versions.bat >nul 2>nul

:menu
cls
echo ========================================================
echo                 Sutu Release Helper
echo ========================================================
echo.
echo  Current version: !CURRENT_VERSION!
echo.
echo  Select release type:
echo.
echo  [1] Patch  : bug fixes   (!CURRENT_VERSION! -^> !NEXT_PATCH!)
echo  [2] Minor  : new features (!CURRENT_VERSION! -^> !NEXT_MINOR!)
echo  [3] Major  : breaking changes (!CURRENT_VERSION! -^> !NEXT_MAJOR!)
echo  [4] Exit
echo  [5] Remote package preview (no release)
echo.
echo ========================================================
echo.

set "choice="
set /p "choice=Select [1-5]: "

if "%choice%"=="1" set "vtype=patch"
if "%choice%"=="2" set "vtype=minor"
if "%choice%"=="3" set "vtype=major"
if "%choice%"=="4" goto :eof
if "%choice%"=="5" goto preview_build

if not defined vtype (
    echo Invalid input.
    timeout /t 2 >nul
    goto menu
)

echo.
echo --------------------------------------------------------
echo [0/2] Local pre-release check
echo --------------------------------------------------------
echo.
set "run_local_check="
set /p "run_local_check=Run local checks first? Y/N [Y recommended]: "

if /i "!run_local_check!"=="Y" (
    powershell -NoProfile -ExecutionPolicy Bypass -File ".dev\pre_release_check.ps1"
    if errorlevel 1 (
        echo.
        echo [ERROR] Local checks failed.
        set "force_publish="
        set /p "force_publish=Continue release anyway? Y/N: "
        if /i not "!force_publish!"=="Y" (
            echo Release cancelled. Returning to menu.
            timeout /t 2 >nul
            set "vtype="
            goto menu
        )
    )
) else (
    echo Local checks skipped.
)

echo.
echo --------------------------------------------------------
echo [1/2] Running npm version !vtype! ...
echo --------------------------------------------------------
echo.
echo  This will:
echo    1. Update package.json version
echo    2. Sync tauri.conf.json and Cargo.toml
echo    3. Create git commit and tag
echo.
call npm version !vtype!
if errorlevel 1 (
    echo.
    echo [ERROR] Version update failed.
    echo Please check local git status.
    pause
    set "vtype="
    goto menu
)

echo.
echo --------------------------------------------------------
echo [2/2] Push release tag to GitHub
echo --------------------------------------------------------
echo This will trigger GitHub Actions release build for Windows and macOS.
echo.
set "confirm="
set /p "confirm=Push now? Y/N: "

if /i "!confirm!"=="Y" (
    echo.
    echo Pushing...
    git push --follow-tags
    if !errorlevel! equ 0 (
        echo.
        echo ========================================================
        echo Release push succeeded.
        echo Check build progress:
        echo https://github.com/LiuYangArt/PaintBoard/actions
        echo ========================================================
    ) else (
        echo.
        echo [ERROR] Push failed. Check network and git config.
    )
) else (
    echo.
    echo Push cancelled. Version/tag remain local.
    echo You can push later with: git push --follow-tags
)

pause
goto :eof

:preview_build
echo.
echo --------------------------------------------------------
echo Trigger remote package preview (no release)
echo --------------------------------------------------------

set "current_branch="
for /f %%i in ('git rev-parse --abbrev-ref HEAD') do set "current_branch=%%i"
if not defined current_branch set "current_branch=main"

echo Current branch: !current_branch!
echo Triggering workflow: package-preview.yml
gh workflow run package-preview.yml --ref !current_branch!

if !errorlevel! equ 0 (
    echo.
    echo Remote package preview triggered.
    echo See workflow runs:
    echo https://github.com/LiuYangArt/PaintBoard/actions/workflows/package-preview.yml
) else (
    echo.
    echo [ERROR] Failed to trigger preview workflow.
    set "default_branch="
    for /f %%i in ('gh repo view --json defaultBranchRef --jq ".defaultBranchRef.name" 2^>nul') do set "default_branch=%%i"
    if not defined default_branch set "default_branch=main"

    echo Default branch: !default_branch!
    echo Current branch: !current_branch!
    echo.
    echo Most likely cause:
    echo - package-preview.yml does not exist on remote default branch yet.
    echo.
    if /i "!current_branch!"=="!default_branch!" (
        set "push_now="
        set /p "push_now=Push current branch now and retry? Y/N: "
        if /i "!push_now!"=="Y" (
            git push -u origin !current_branch!
            if !errorlevel! equ 0 (
                echo.
                echo Retrying workflow trigger...
                gh workflow run package-preview.yml --ref !current_branch!
                if !errorlevel! equ 0 (
                    echo.
                    echo Remote package preview triggered.
                    echo See workflow runs:
                    echo https://github.com/LiuYangArt/PaintBoard/actions/workflows/package-preview.yml
                ) else (
                    echo.
                    echo [ERROR] Retry failed.
                    echo Open Actions page and verify workflow file exists on default branch.
                )
            ) else (
                echo.
                echo [ERROR] Push failed. Could not retry workflow trigger.
            )
        )
    ) else (
        echo Switch to default branch !default_branch! and push workflow file first.
        echo Then retry option [5].
    )
)

pause
goto menu
