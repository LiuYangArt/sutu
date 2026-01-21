---
trigger: always_on
---

**PaintBoard** 是一个专业绘画软件，追求低延迟数位板输入体验。
这是一个纯AI vibe-coding项目，所有开发方案以ai native优先。

| 技术栈   | 说明                         |
| -------- | ---------------------------- |
| 前端     | React 18 + TypeScript + Vite |
| 后端     | Tauri 2.x + Rust             |
| 状态管理 | Zustand + Immer              |
| 图标     | lucide-react                 |

**目标**: Wacom 数位板输入延迟 < 12ms

## 常用命令

```bash
# 开发
pnpm dev              # 启动开发服务器（前后端热重载）
pnpm build            # 生产构建

# 检查
pnpm check:all        # 全量检查（类型 + lint + 测试）
pnpm format           # 格式化代码

# 发布
.dev/publish_release.bat  # 版本发布助手
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Tauri 应用                        │
├─────────────────────────────────────────────────────┤
│  Rust 后端 (src-tauri/)                             │
│  ├── input/     → 数位板输入（WinTab/PointerEvent） │
│  ├── brush/     → [Reserved] 纯数值计算备用          │
│  └── commands.rs→ Tauri IPC 命令                    │
├─────────────────────────────────────────────────────┤
│  前端 (src/)                         IPC ↑↓         │
│  ├── components/→ React UI 组件                     │
│  ├── gpu/       → WebGPU 渲染 (Primary Engine)      │
│  └── utils/     → TypeScript 渲染 (Fallback Engine) │
└─────────────────────────────────────────────────────┘
```

### 数据流: 笔触输入 → 画布渲染

1. **WinTab/PointerEvent** 捕获原始输入 (Rust)
2. **IPC** 传输至前端
3. **Frontend Brush Engine** (TS): 插值、抖动、生成 Dabs
4. **Renderer** (WebGPU/Canvas2D): 绘制到 Stroke Buffer 并合成

## 代码规范

### 语言约定

- **代码/注释/标识符/提交信息**: 英文
- **讨论/文档**: 中文

### 文件命名

| 类型       | 规则       | 示例              |
| ---------- | ---------- | ----------------- |
| React 组件 | PascalCase | `LayerPanel.tsx`  |
| 工具函数   | camelCase  | `colorUtils.ts`   |
| Rust 模块  | snake_case | `brush_engine.rs` |

### TypeScript

- 路径别名: `@/*` → `./src/*`
- 严格模式，禁止 `any`
- 图标: `lucide-react`（工具栏 size={18}，行内更小）

### Rust

- Clippy: `unwrap_used` 和 `expect_used` 为警告
- 日志: 使用 `tracing`，不用 `println!`
- 错误: Tauri 命令返回 `Result<T, String>`

### 文件大小限制

- **单个文件不超过 1000 行**
- 超过 500 行时应开始考虑拆分
- 超过 1000 行时必须拆分为多个模块

## 关键数据结构

**Rust** (`src-tauri/src/`):

- `RawInputPoint` - 原始输入（坐标、压感、倾斜、时间戳）

**Frontend** (`src/`):

- `DabParams` - 笔刷印章参数 (x, y, size, flow, etc.)
- `BrushRenderConfig` - 渲染配置
- `StrokeAccumulator` - 笔划累积缓冲 (CPU/GPU)

**State Management** (`src/stores/`):

- `useDocumentStore` - 文档状态、图层管理
- `useToolStore` - 当前工具、笔刷设置、颜色

### 持久化设置： C:\Users\<用户名>\AppData\Roaming\com.paintboard\settings.json

## 相关文档

- **UI 规范**: [ui-guidelines.md](file:///f:/CodeProjects/PaintBoard/docs/ui-guidelines.md)
- **架构设计**: [architecture.md](file:///f:/CodeProjects/PaintBoard/docs/architecture.md)
- **测试策略**: [testing-strategy.md](file:///f:/CodeProjects/PaintBoard/docs/testing-strategy.md)
- **开发环境搭建**: [development-setup.md](file:///f:/CodeProjects/PaintBoard/docs/development-setup.md)
- **开发路线图**: [development-roadmap.md](file:///f:/CodeProjects/PaintBoard/docs/todo/development-roadmap.md)
- **项目灵感**: [project_idea.md](file:///f:/CodeProjects/PaintBoard/docs/project_idea.md)
- **DEBUG经验**: @docs/postmortem/
- **kirta源码**: F:\CodeProjects\krita\

## 开发阶段

参见 `docs/todo/development-roadmap.md` 获取完整路线图。

## 版本管理

版本号唯一来源: `package.json`

## Plan Mode

- 提出计划时检查计划的置信度，如果不够高，尝试通过修改计划提高。
- 当置信度无法再提高时，把疑虑明确告知用户。
