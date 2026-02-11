**Sutu** 速涂是一个专业绘画软件，追求低延迟数位板输入体验。目标平台 windows x86, 未来计划兼容macos和ipad
这是一个纯AI vibe-coding项目，所有开发方案以ai native优先。

| 技术栈   | 说明                         |
| -------- | ---------------------------- |
| 前端     | React 18 + TypeScript + Vite |
| 后端     | Tauri 2.x + Rust             |
| 状态管理 | Zustand + Immer              |
| 图标     | lucide-react                 |

**目标**: Wacom 数位板输入延迟 < 12ms

## 笔刷系统

当前采用 **GPU-First** 架构：实时绘画链路以 WebGPU 为主，默认不走 GPU→CPU readback。
CPU 路径仅用于 fallback（设备不支持 WebGPU）和一致性校验，不再作为实时主链路。
笔刷系统目标是对齐 Photoshop 的手感与视觉结果。
当前阶段进度与约束以 `docs/design/done/2026-02-05-gpu-first-brush-design.md`（GPU-first 改造归档）为准。

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
│  │   ├── Canvas/    → 画布核心 (拆分为多个 hooks)    │
│  │   ├── Toolbar/   → 工具栏 (按工具动态切换)       │
│  │   └── ...                                        │
│  ├── gpu/       → WebGPU 绘画/合成主链路             │
│  └── utils/     → TypeScript 工具与 fallback 逻辑    │
└─────────────────────────────────────────────────────┘
```

### 数据流: 笔触输入 → 画布渲染

1. **WinTab/PointerEvent** 捕获原始输入 (Rust)
2. **IPC** 传输至前端
3. **Frontend Brush Engine** (TS): 插值、抖动、生成 Dabs
4. **Renderer** (WebGPU): 实时写入 Stroke Buffer 并合成到显示层（绘画阶段不做 readback）
5. **Export/Snapshot**: 仅在导出/截图时执行显式 readback

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
- `GPUStrokeAccumulator` - GPU 笔划累积缓冲（active scratch）
- `GpuLayerStore` - 图层 tile 纹理存储
- `TileResidencyManager` - tile 常驻/LRU 预算管理
- `GpuStrokeCommitCoordinator` - 笔触提交与历史回写协调
- `GpuStrokeHistoryStore` - GPU 脏 tile 历史快照
- `exportReadback` - 导出/截图 readback 路径

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
- **GPU-First 归档**: [2026-02-05-gpu-first-brush-design.md](file:///f:/CodeProjects/PaintBoard/docs/design/done/2026-02-05-gpu-first-brush-design.md)
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
