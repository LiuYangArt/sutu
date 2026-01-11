# .dev 目录

此目录包含开发辅助脚本。

## 使用方式

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
```

## 快捷方式

可以在项目根目录创建快捷方式：

```powershell
# 创建别名 (添加到 $PROFILE)
function pb { & "$PSScriptRoot\.dev\dev.ps1" @args }
```

然后就可以用 `pb dev`、`pb build` 等命令。
