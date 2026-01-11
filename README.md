# PaintBoard

专业级绘画软件，支持 Wacom 压感输入，基于 Tauri + React + Rust 构建。

## 特性

- 🖌️ **低延迟压感输入** — 针对 Wacom 数位板优化，目标 < 12ms 延迟
- 🎨 **专业图层系统** — 支持混合模式、透明度、图层组
- 🖼️ **大画布支持** — 最高 16K x 16K 分辨率
- 📁 **PSD 兼容** — 读取和保存 Photoshop 文件

## 技术栈

| 层级 | 技术 |
|------|------|
| 应用框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript |
| 渲染 | WebGPU |
| 后端 | Rust |
| 输入采集 | octotablet |

## 快速开始

### 环境要求

- Windows 10 (1903+) / Windows 11
- Node.js 20+
- Rust 1.75+
- pnpm 8+

### 安装依赖

```bash
# 安装前端依赖
pnpm install

# Rust 依赖会在首次构建时自动安装
```

### 开发模式

```bash
# 启动开发服务器
pnpm dev
```

### 构建发布版

```bash
pnpm build
```

## 项目结构

```
PaintBoard/
├── docs/                   # 文档
│   ├── architecture.md     # 架构设计
│   ├── development-setup.md # 开发环境
│   └── testing-strategy.md # 测试策略
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── stores/             # Zustand 状态
│   └── styles/             # CSS 样式
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── brush/          # 笔刷引擎
│   │   ├── input/          # 输入处理
│   │   └── commands.rs     # Tauri 命令
│   └── Cargo.toml
└── package.json
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 构建生产版本 |
| `pnpm test` | 运行前端测试 |
| `pnpm check:all` | 运行所有检查 |
| `pnpm lint` | 代码检查 |
| `pnpm format` | 代码格式化 |

## 文档

- [架构设计](docs/architecture.md)
- [开发环境配置](docs/development-setup.md)
- [测试策略](docs/testing-strategy.md)

## 许可证

MIT
