# PaintBoard 架构设计文档

> 版本: 0.1.0 | 最后更新: 2026-01-11

## 1. 项目定位

**PaintBoard** 是一款专业级绘画软件，目标是在 Windows 平台上提供：

- 极低延迟的压感输入响应（< 12ms）
- Photoshop 级别的图层和混合模式
- 专业笔刷系统
- PSD 文件兼容

**开发理念**：Vibe Coding —— 在保证性能的前提下，最大化开发体验和迭代速度。

---

## 2. 技术栈选型

| 层级         | 技术选型               | 选型理由                                 |
| ------------ | ---------------------- | ---------------------------------------- |
| **应用框架** | Tauri 2.x              | Rust 后端 + Web 前端，兼顾性能与开发效率 |
| **前端框架** | React 18 + TypeScript  | 生态成熟，组件化开发                     |
| **渲染引擎** | WebGPU                 | 现代 GPU API，接近原生性能               |
| **输入采集** | octotablet (Rust)      | 跨平台压感/倾斜采集，绕过 WebView 延迟   |
| **笔刷计算** | Rust (可选编译为 WASM) | 高性能计算，零 GC 开销                   |
| **文件格式** | psd crate + 自定义格式 | PSD 兼容 + 高效内部格式                  |

---

## 3. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         PaintBoard                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Rust 后端 (Tauri)                        │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │ Input       │  │ Brush       │  │ File I/O            │ │ │
│  │  │ Pipeline    │  │ Compute     │  │                     │ │ │
│  │  │             │  │ (Reserve)   │  │ - PSD read/write    │ │ │
│  │  │ octotablet  │─►│ 纯数值计算  │  │ - 项目文件          │ │ │
│  │  │ 压感采集    │  │ 无渲染      │  │ - 自动保存          │ │ │
│  │  │             │  │             │  │                     │ │ │
│  │  └─────────────┘  └──────┬──────┘  └─────────────────────┘ │ │
│  │                          │                                  │ │
│  └──────────────────────────┼──────────────────────────────────┘ │
│                             │ Tauri Events (IPC)                 │
│                             ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                 前端 (React + WebGPU)                       │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌────────────────────┐  ┌──────────────┐ │ │
│  │  │ Canvas      │  │ GPU-First Brush    │  │ UI Systems   │ │ │
│  │  │ Renderer    │  │ Engine             │  │              │ │ │
│  │  │             │  │                    │  │ - Layers     │ │ │
│  │  │ WebGPU      │◄─┤ 1. 实时绘画主链路   │  │ - Tools      │ │ │
│  │  │ (Primary)   │  │    (GPU, No-Readback)│ │ - Settings   │ │ │
│  │  │             │  │ 2. CPU Fallback /  │  │              │ │ │
│  │  │ CPU Fallback│◄─┤    Parity Gate     │  │              │ │ │
│  │  │ (Conditional)│ │                    │  │              │ │ │
│  │  └─────────────┘  └────────────────────┘  └──────────────┘ │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 核心模块设计

### 4.1 GPU-First 笔刷引擎 (GPU-First Brush Engine)

鉴于 IPC 通信在高频图像传输上的瓶颈，生产环境采用 **GPU-First + Tile** 架构。Rust 后端主要负责 I/O 与输入采集，前端 GPU 负责实时绘画与合成。

**渲染路径优先级**:

1.  **GPU 实时路径 (Primary)**:
    - **技术**: WebGPU + tile 化存储与合成
    - **场景**: 默认实时绘画路径
    - **约束**: 绘画阶段不执行 GPU→CPU readback

2.  **CPU 路径 (Fallback)**:
    - **技术**: TypeScript CPU 渲染
    - **场景**: WebGPU 不可用或 GPU 路径异常时
    - **定位**: 兼容性兜底，不是实时主链路

```
Input Event (Pointer/Wintab)
    │
    ▼
┌─────────────────────────────────┐
│ InputProcessor (Rust/TS)        │
│ - 压感曲线应用                   │
│ - 笔身动态计算 (Tilt/Rotation)   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ BrushStamper (TypeScript)       │
│ - 间距计算 (Spacing)             │
│ - 抖动处理 (Jitter)              │
│ - 生成 Dab 序列                  │
└──────────────┬──────────────────┘
               │ Dabs
               ▼
┌─────────────────────────────────┐
│ GPU Stroke Path (Primary)       │
│ - GPUStrokeAccumulator          │
│ - activeScratch (rgba16float)  │
│ - Tile dirty-rect commit       │
└──────────────┬──────────────────┘
               │
               ├──────────────► CPU Fallback (Conditional)
               │
               ▼
┌─────────────────────────────────┐
│ Compositor                      │
│ - Tile Layer Blending           │
│ - Display Surface Updated       │
└─────────────────────────────────┘
```

**关键数据结构**:

```rust
/// 原始输入点
pub struct RawInputPoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,      // 0.0 - 1.0
    pub tilt_x: f32,        // 倾斜角度
    pub tilt_y: f32,
    pub timestamp_ms: u64,  // 高精度时间戳
}

/// 笔刷渲染段
pub struct StrokeSegment {
    pub points: Vec<BrushPoint>,
    pub brush_id: u32,
    pub color: [f32; 4],    // RGBA
    pub blend_mode: BlendMode,
}

pub struct BrushPoint {
    pub x: f32,
    pub y: f32,
    pub size: f32,          // 经过压感曲线处理后的大小
    pub opacity: f32,       // 经过压感曲线处理后的不透明度
    pub rotation: f32,      // 笔刷旋转角度
}
```

### 4.2 渲染引擎 (Canvas Renderer)

**核心职责**：

- 管理画布纹理（支持 8K x 8K）
- 图层合成
- 实时笔刷预览
- 视口变换（缩放/平移/旋转）

**Canvas 模块结构（拆分后）**：

```
Canvas/
├── index.tsx           # 主组件，组合所有 hooks
├── useLayerOperations  # 图层操作
├── useGlobalExports    # window.__ 全局方法
├── useKeyboardShortcuts# 键盘快捷键
├── usePointerHandlers  # 指针事件
├── useStrokeProcessor  # 笔触处理/RAF
├── useBrushRenderer    # (已有) 笔刷渲染
├── useSelectionHandler # (已有) 选区处理
└── useCursor           # (已有) 光标
```

**分层渲染策略**:

```
┌─────────────────────────────────┐
│ 最终显示                        │  ← GPU 合成输出
├─────────────────────────────────┤
│ UI 覆盖层 (选区边框等)          │  ← 矢量渲染
├─────────────────────────────────┤
│ 实时预览层 (当前笔划)           │  ← 低延迟更新
├─────────────────────────────────┤
│ 图层组合缓存                    │  ← 按需重算
├─────────────────────────────────┤
│ 各图层纹理                      │  ← 独立 GPU 纹理
└─────────────────────────────────┘
```

**关键优化**:

1. **Tile-based rendering**: 大画布分块，只更新变化区域
2. **图层缓存**: 未修改的图层组合结果缓存
3. **双缓冲**: 预览层使用独立缓冲，避免闪烁

### 4.3 图层系统 (Layer Manager)

```typescript
interface Layer {
  id: string;
  name: string;
  type: 'raster' | 'group' | 'adjustment';
  visible: boolean;
  locked: boolean;
  opacity: number; // 0-100
  blendMode: BlendMode;
  parent?: string; // 图层组父级
  children?: string[]; // 图层组子级

  // 仅 raster 类型
  textureId?: string; // GPU 纹理引用
  bounds?: Rect; // 内容边界（用于优化）
}

type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';
```

### 4.4 文件系统 (File I/O)

| 格式                        | 用途      | 实现方式                             |
| --------------------------- | --------- | ------------------------------------ |
| `.psd`                      | 导入/导出 | `psd` crate                          |
| `.pbp` (PaintBoard Project) | 原生格式  | 自定义，基于 FlatBuffers/MessagePack |
| `.png/.jpg`                 | 导出      | `image` crate                        |

**自动保存策略**:

- 每 60 秒检查是否有未保存更改
- 增量保存到 `.pbp.autosave`
- 异常退出后自动恢复

---

## 5. 状态管理

### 5.1 前端状态 (Zustand)

```typescript
interface AppState {
  // 文档状态
  document: {
    width: number;
    height: number;
    dpi: number;
    layers: Layer[];
    activeLayerId: string;
  };

  // 工具状态
  tool: {
    current: ToolType;
    brushSettings: BrushSettings;
    foregroundColor: Color;
    backgroundColor: Color;
  };

  // 视图状态
  view: {
    zoom: number;
    panX: number;
    panY: number;
    rotation: number;
  };

  // 历史记录
  history: {
    undoStack: HistoryEntry[];
    redoStack: HistoryEntry[];
  };
}
```

### 5.2 Rust 后端状态

```rust
pub struct AppState {
    /// 输入处理器实例
    pub input_processor: InputProcessor,

    /// 当前文档（如果打开）
    pub document: Option<Document>,

    /// 笔刷引擎
    pub brush_engine: BrushEngine,

    /// 用户配置
    pub config: UserConfig,
}
```

---

## 6. IPC 通信协议

### 6.1 Tauri Commands (前端 → 后端)

```rust
#[tauri::command]
async fn save_document(path: String, state: AppWindow) -> Result<(), String>;

#[tauri::command]
async fn load_document(path: String) -> Result<DocumentInfo, String>;

#[tauri::command]
fn get_brush_preview(brush_id: u32, size: u32) -> Vec<u8>;
```

### 6.2 Tauri Events (后端 → 前端)

```typescript
// 笔刷数据流（高频）
interface StrokeDataEvent {
  segments: StrokeSegment[];
}

// 输入状态（低频）
interface InputStateEvent {
  connected: boolean;
  deviceName: string;
  pressure: number; // 实时压感（用于 UI 显示）
}
```

---

## 7. 性能预算

| 指标                | 目标值   | 测量方式              |
| ------------------- | -------- | --------------------- |
| 输入延迟            | < 12ms   | 高速摄像 + 时间戳对比 |
| 笔刷渲染帧率        | ≥ 120fps | Performance API       |
| 图层合成时间 (10层) | < 8ms    | GPU 时间戳查询        |
| 内存占用 (8K 画布)  | < 2GB    | 系统监控              |
| 冷启动时间          | < 2s     | 启动计时              |

---

## 8. 扩展性考虑

### 8.1 插件系统 (未来)

预留插件接口：

- 自定义笔刷
- 滤镜效果
- 文件格式支持

### 8.2 跨平台 (未来)

当前优先 Windows，架构设计兼容：

- macOS (octotablet 已支持)
- Linux (X11/Wayland)

---

## 9. 风险与缓解

| 风险                        | 影响             | 缓解策略                 |
| --------------------------- | ---------------- | ------------------------ |
| WebGPU 兼容性               | 部分老显卡不支持 | 提供 WebGL2 降级方案     |
| octotablet 不支持某些数位板 | 输入失效         | 备选 PointerEvent 方案   |
| PSD 格式复杂性              | 导入/导出不完整  | 渐进式支持，明确功能边界 |
| 大画布内存压力              | OOM 崩溃         | 分块加载 + 内存监控告警  |

---

## 附录 A: 技术依赖

### Rust (Cargo.toml)

```toml
[dependencies]
tauri = { version = "2", features = ["shell-open", "dialog"] }
octotablet = "0.4"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
psd = "0.3"
image = "0.25"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"  # 性能基准测试
```

### 前端 (package.json)

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@tauri-apps/api": "^2.0.0",
    "zustand": "^4.5.0",
    "@webgpu/types": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@tauri-apps/cli": "^2.0.0",
    "vitest": "^1.0.0",
    "@testing-library/react": "^14.0.0"
  }
}
```
