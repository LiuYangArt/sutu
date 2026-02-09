@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: 切换到项目根目录 (.dev 的父目录)
cd /d "%~dp0.."

:: Get versions using Node.js
node -e "const v = require('./package.json').version; const [ma, mi, pa] = v.split('.').map(Number); console.log('set CURRENT_VERSION=' + v); console.log('set NEXT_PATCH=' + ma + '.' + mi + '.' + (pa + 1)); console.log('set NEXT_MINOR=' + ma + '.' + (mi + 1) + '.0'); console.log('set NEXT_MAJOR=' + (ma + 1) + '.0.0');" > versions.bat

call versions.bat
del versions.bat

:menu
cls
echo ========================================================
echo       PaintBoard 一键发布助手
echo ========================================================
echo.
echo  当前版本: !CURRENT_VERSION!
echo.
echo  请选择升级类型：
echo.
echo  [1] 补丁 (Patch) : 修复 Bug (!CURRENT_VERSION! -^> !NEXT_PATCH!)
echo  [2] 次版本 (Minor): 新增功能 (!CURRENT_VERSION! -^> !NEXT_MINOR!)
echo  [3] 主版本 (Major): 重大变更 (!CURRENT_VERSION! -^> !NEXT_MAJOR!)
echo  [4] 退出
echo  [5] 远程预检打包 (不发版, 仅构建验证)
echo.
echo ========================================================
echo.

set /p choice="请输入选项 [1-5]: "

if "%choice%"=="1" set vtype=patch
if "%choice%"=="2" set vtype=minor
if "%choice%"=="3" set vtype=major
if "%choice%"=="4" goto :eof
if "%choice%"=="5" goto preview_build

if not defined vtype (
    echo 无效输入，请重新选择。
    timeout /t 2 >nul
    goto menu
)

echo.
echo --------------------------------------------------------
echo [0/2] 发布前本地预检
echo --------------------------------------------------------
echo.
set /p run_local_check="是否执行本地预检? (Y/N, 推荐Y): "

if /i "!run_local_check!"=="y" (
    powershell -NoProfile -ExecutionPolicy Bypass -File ".dev\pre_release_check.ps1"
    if !errorlevel! neq 0 (
        echo.
        echo [错误] 本地预检未通过，建议先修复再发布。
        set /p force_publish="仍要继续发布吗? (Y/N): "
        if /i not "!force_publish!"=="y" (
            echo 已取消发布，返回菜单。
            timeout /t 2 >nul
            goto menu
        )
    )
) else (
    echo 已跳过本地预检。
)

echo.
echo --------------------------------------------------------
echo [1/2] 正在执行 npm version %vtype% ...
echo --------------------------------------------------------
echo.
echo  该命令将会:
echo    1. 更新 package.json 版本号
echo    2. 自动同步到 tauri.conf.json 和 Cargo.toml
echo    3. 创建 git commit 和 tag
echo.
call npm version %vtype%

if %errorlevel% neq 0 (
    echo.
    echo [错误] 版本更新失败！请检查是否有未提交的更改。
    echo 按任意键返回...
    pause >nul
    goto menu
)

echo.
echo --------------------------------------------------------
echo [2/2] 准备推送到 GitHub ...
echo --------------------------------------------------------
echo 即将把新版本标签推送到远程仓库，这将触发 GitHub Actions 自动发布（Windows + macOS）。
echo.
set /p confirm="确认推送吗? (Y/N): "

if /i "%confirm%"=="y" (
    echo.
    echo 正在推送...
    git push --follow-tags

    if !errorlevel! equ 0 (
        echo.
        echo ========================================================
        echo  ✅ 发布成功！
        echo  请访问 GitHub 仓库的 Actions 页面查看 Windows/macOS 构建进度。
        echo  https://github.com/LiuYangArt/PaintBoard/actions
        echo ========================================================
    ) else (
        echo.
        echo [错误] 推送失败，请检查网络或 Git 配置。
    )
) else (
    echo.
    echo 已取消推送。版本号已在本地更新并提交。
    echo 你稍后可以手动运行: git push --follow-tags
)

pause
goto :eof

:preview_build
echo.
echo --------------------------------------------------------
echo 触发远程预检打包 (不发版)
echo --------------------------------------------------------
for /f %%i in ('git rev-parse --abbrev-ref HEAD') do set current_branch=%%i
if not defined current_branch set current_branch=main

echo 当前分支: !current_branch!
echo 正在触发 GitHub Actions workflow: package-preview.yml
gh workflow run package-preview.yml --ref !current_branch!

if !errorlevel! equ 0 (
    echo.
    echo 已触发远程预检打包。
    echo 可在以下页面查看运行状态:
    echo https://github.com/LiuYangArt/PaintBoard/actions/workflows/package-preview.yml
) else (
    echo.
    echo [错误] 触发失败，请检查 gh 登录状态或 workflow 文件是否已推送。
)

pause
goto menu
