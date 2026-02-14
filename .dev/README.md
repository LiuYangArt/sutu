# .dev 目录

此目录包含开发辅助脚本。

## 使用方式

### macOS / Linux (Shell)

```bash
# 给脚本执行权限（首次）
chmod +x .dev/dev.sh .dev/dev.command

# 菜单模式
./.dev/dev.sh

# 命令模式
./.dev/dev.sh bootstrap
./.dev/dev.sh dev
./.dev/dev.sh check
./.dev/dev.sh doctor
```

在 macOS Finder 中也可以双击 `.dev/dev.command` 打开菜单。

### PowerShell (推荐)

```powershell
# 安装依赖
.\.dev\dev.ps1 install

# 启动开发服务器
.\.dev\dev.ps1 dev

# 构建项目
.\.dev\dev.ps1 build

# 构建发布版
.\.dev\dev.ps1 build-release

# 运行测试
.\.dev\dev.ps1 test

# 运行所有检查
.\.dev\dev.ps1 check

# 格式化代码
.\.dev\dev.ps1 format

# 清理构建产物
.\.dev\dev.ps1 clean
```

### CMD

```cmd
.dev\dev.bat install
.dev\dev.bat dev
.dev\dev.bat build
.dev\issue.bat
.dev\issue.bat today
.dev\issue.bat workflow-full
```

## Issue 自动化助手

新增 `.dev\issue.bat`，支持菜单模式（双击）和命令模式。

常用命令：

```cmd
.dev\issue.bat today
.dev\issue.bat triage-readonly
.dev\issue.bat workflow-incremental
.dev\issue.bat workflow-full
.dev\issue.bat workflow-retry
```

说明：

- `triage-readonly` 是本地安全演练，不会改线上 issue。
- `triage-incremental` / `triage-full` 会改线上 issue 标签/评论，脚本内有二次确认。

## 快捷方式

可以在项目根目录创建快捷方式：

```powershell
# 创建别名 (添加到 $PROFILE)
function pb { & "$PSScriptRoot\.dev\dev.ps1" @args }
```

然后就可以用 `pb dev`、`pb build` 等命令。
