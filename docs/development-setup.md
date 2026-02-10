# 开发环境与工具链配置

> 版本: 0.1.0 | 最后更新: 2026-01-11

## 1. 环境要求

### 1.1 系统要求

| 项目 | 最低要求 | 推荐配置 |
|------|----------|----------|
| 操作系统 | Windows 10 (1903+) | Windows 11 |
| 内存 | 8 GB | 16 GB+ |
| 显卡 | 支持 Vulkan 1.1 / DX12 | 独立显卡，支持 WebGPU |
| 硬盘 | 10 GB 可用空间 | SSD |

### 1.2 软件依赖

| 工具 | 版本 | 用途 |
|------|------|------|
| **Rust** | 1.75+ | 后端开发 |
| **Node.js** | 20 LTS | 前端开发 |
| **pnpm** | 8+ | 包管理（推荐） |
| **Visual Studio Build Tools** | 2022 | Rust Windows 编译 |
| **WebView2 Runtime** | 最新 | Tauri 渲染引擎 |

---

## 2. 环境安装

### 2.1 一键安装脚本 (PowerShell)

```powershell
# 以管理员权限运行
# 安装 Rust
winget install Rustlang.Rustup

# 安装 Node.js
winget install OpenJS.NodeJS.LTS

# 安装 pnpm
npm install -g pnpm

# 安装 VS Build Tools (C++ 工具链)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 验证安装
rustc --version
node --version
pnpm --version
```

### 2.2 Rust 工具链配置

```bash
# 安装 nightly 工具链（可选，用于某些高级特性）
rustup toolchain install nightly

# 安装常用组件
rustup component add clippy rustfmt rust-analyzer

# 安装 Tauri CLI
cargo install tauri-cli

# 安装 cargo-watch（热重载）
cargo install cargo-watch
```

### 2.3 IDE 配置

#### VS Code 推荐扩展

```json
// .vscode/extensions.json
{
  "recommendations": [
    "rust-lang.rust-analyzer",
    "tauri-apps.tauri-vscode",
    "bradlc.vscode-tailwindcss",
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "usernamehw.errorlens",
    "eamodio.gitlens",
    "wayou.vscode-todo-highlight"
  ]
}
```

#### VS Code 工作区设置

```json
// .vscode/settings.json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  },
  "rust-analyzer.check.command": "clippy",
  "rust-analyzer.cargo.features": "all",
  "typescript.preferences.importModuleSpecifier": "relative",
  "files.associations": {
    "*.css": "tailwindcss"
  }
}
```

---

## 3. 项目结构

> [!NOTE]
> 本节目录树是初始化示例，可能落后于当前实现。请以仓库根目录 `.codebase_index.md` 和 `docs/design/done/2026-02-05-gpu-first-brush-design.md`（GPU-first 改造归档）为准。

```
PaintBoard/
├── docs/                       # 文档
│   ├── architecture.md         # 架构设计
│   ├── development-setup.md    # 本文件
│   └── testing-strategy.md     # 测试策略
│
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── main.rs             # 入口
│   │   ├── lib.rs              # 库导出
│   │   ├── input/              # 输入管线模块
│   │   │   ├── mod.rs
│   │   │   ├── processor.rs    # 输入处理器
│   │   │   └── tablet.rs       # 数位板集成
│   │   ├── brush/              # 笔刷引擎模块
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs       # 核心引擎
│   │   │   └── interpolation.rs # 插值算法
│   │   ├── file/               # 文件 I/O 模块
│   │   │   ├── mod.rs
│   │   │   ├── psd.rs          # PSD 读写
│   │   │   └── project.rs      # 项目格式
│   │   └── commands.rs         # Tauri commands
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── build.rs
│
├── src/                        # 前端源码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 根组件
│   ├── components/             # UI 组件
│   │   ├── Canvas/             # 画布组件
│   │   ├── LayerPanel/         # 图层面板
│   │   ├── Toolbar/            # 工具栏
│   │   └── ColorPicker/        # 色盘
│   ├── hooks/                  # React Hooks
│   │   ├── useTabletInput.ts   # 数位板输入
│   │   └── useWebGPU.ts        # WebGPU 渲染
│   ├── stores/                 # Zustand 状态
│   │   ├── document.ts         # 文档状态
│   │   └── tool.ts             # 工具状态
│   ├── gpu/                    # WebGPU 渲染器
│   │   ├── renderer.ts         # 核心渲染器
│   │   ├── shaders/            # WGSL 着色器
│   │   └── textures.ts         # 纹理管理
│   └── utils/                  # 工具函数
│
├── tests/                      # 测试
│   ├── rust/                   # Rust 测试
│   └── e2e/                    # 端到端测试
│
├── .github/                    # GitHub Actions
│   └── workflows/
│       ├── ci.yml              # 持续集成
│       └── release.yml         # 发布流程
│
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 4. 开发命令

### 4.1 日常开发

```bash
# 启动开发服务器（前端热重载 + 后端监听）
pnpm dev

# 仅启动前端
pnpm dev:frontend

# 仅构建 Rust（不启动）
pnpm build:rust

# 运行 Tauri 开发模式
pnpm tauri dev
```

### 4.2 代码质量

```bash
# 格式化所有代码
pnpm format

# 运行 linter
pnpm lint

# 类型检查
pnpm typecheck

# Rust clippy 检查
cargo clippy --all-features -- -D warnings

# 所有检查（用于 CI）
pnpm check:all
```

### 4.3 测试

```bash
# 运行前端单元测试
pnpm test

# 运行 Rust 测试
cargo test

# 运行端到端测试
pnpm test:e2e

# 运行性能基准测试
cargo bench
```

### 4.4 构建

```bash
# 开发构建
pnpm build:dev

# 生产构建
pnpm build

# 生成安装包
pnpm tauri build
```

---

## 5. 配置文件

### 5.1 package.json 脚本

```json
{
  "scripts": {
    "dev": "tauri dev",
    "dev:frontend": "vite",
    "build": "vite build && tauri build",
    "build:dev": "vite build",
    "build:rust": "cd src-tauri && cargo build",

    "format": "prettier --write \"src/**/*.{ts,tsx}\" && cargo fmt --manifest-path src-tauri/Cargo.toml",
    "lint": "eslint src --ext .ts,.tsx --fix",
    "lint:rust": "cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings",
    "typecheck": "tsc --noEmit",

    "check:all": "pnpm typecheck && pnpm lint && pnpm lint:rust && pnpm test",

    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",

    "prepare": "husky install"
  }
}
```

### 5.2 Vite 配置

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Tauri 开发服务器配置
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },

  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
```

### 5.3 TypeScript 配置

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2021",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,

    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

---

## 6. Git Hooks (Husky + lint-staged)

### 6.1 安装

```bash
pnpm add -D husky lint-staged
pnpm exec husky install
```

### 6.2 配置

```json
// package.json
{
  "lint-staged": {
    "src/**/*.{ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ],
    "src-tauri/**/*.rs": [
      "cargo fmt --manifest-path src-tauri/Cargo.toml --"
    ]
  }
}
```

### 6.3 Pre-commit Hook

```bash
# .husky/pre-commit
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

pnpm lint-staged
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

### 6.4 Pre-push Hook

```bash
# .husky/pre-push
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## 7. 环境变量

### 7.1 开发环境 (.env.development)

```bash
# Tauri 开发模式
TAURI_DEBUG=1

# 日志级别
RUST_LOG=debug

# 前端调试
VITE_DEV_MODE=true
```

### 7.2 生产环境 (.env.production)

```bash
TAURI_DEBUG=0
RUST_LOG=warn
VITE_DEV_MODE=false
```

---

## 8. 常见问题

### Q1: Rust 编译失败，提示找不到 link.exe

**原因**: 未安装 VS Build Tools

**解决**:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

### Q2: WebGPU 不可用

**原因**: 浏览器/WebView2 版本过低或显卡驱动问题

**解决**:
1. 更新 Edge 浏览器到最新版
2. 更新显卡驱动
3. 检查 `edge://gpu` 页面确认 WebGPU 状态

### Q3: 数位板压感无法识别

**检查步骤**:
1. 确认 Wacom 驱动已安装
2. 在 Wacom 设置中启用 Windows Ink
3. 检查应用设置中的输入后端是否为 WinTab/PointerEvent
4. 检查设备管理器中数位板状态

### Q4: 热重载不工作

**解决**:
```bash
# 确保使用正确的开发命令
pnpm tauri dev

# 如果仍有问题，清理缓存
rm -rf node_modules/.vite
cargo clean
```

---

## 9. 推荐工作流

### 9.1 日常开发循环

```
1. git pull origin main
2. pnpm install  # 如果 package.json 有变化
3. pnpm dev      # 启动开发服务器
4. 编写代码...
5. pnpm check:all  # 提交前检查
6. git commit -m "feat: ..."
7. git push
```

### 9.2 功能分支流程

```
1. git checkout -b feat/layer-panel
2. 开发功能...
3. pnpm check:all
4. git commit
5. git push -u origin feat/layer-panel
6. 创建 Pull Request
7. Code Review
8. Merge to main
```
