# Sutu macOS 原生数位板输入计划

> 日期：2026-02-14  
> 状态：Draft  
> 负责人：Input Pipeline

---

## 1. 背景

当前 macOS 实测现象：

- Tablet backend 为 `PointerEvent`。
- Wacom 笔在 WebView 中被识别为 `pointerType=mouse`。
- `pressure=0`、`webkitForce=0`，没有可用压感/倾斜数据流。

这意味着纯网页输入链路在 macOS 上无法满足笔刷动态需求。

---

## 2. 目标

构建 macOS 原生数位板输入路径，并将其作为 macOS 默认主后端。

### 验收目标

- 输入源被识别为 tablet/pen 语义，而非 mouse 语义。
- 笔触过程中持续输出 `[0,1]` 范围压感。
- 设备支持时可读取 tilt。
- 数据可复用现有 `tablet-event-v2` 管线，无需重写前端渲染主链路。
- Windows WinTab 路径无回归。

---

## 3. 非目标（本阶段）

- iPad 原生输入后端。
- 重做笔刷动力学模型。
- 高级特性（如 barrel rotation 全量对齐、校准 UI）。

---

## 4. 方案设计

### 4.1 后端策略

- 保留 `PointerEventBackend` 作为 fallback。
- 新增 `MacNativeBackend` 作为 macOS 主后端。
- 后端优先级：
  - Windows：维持现有 `WinTab` 优先。
  - macOS：`MacNative` 失败后回退 `PointerEvent`。

### 4.2 数据流

1. AppKit/WKWebView Host 层采集原生 tablet 事件（pressure/tilt/proximity）。
2. Rust 侧归一化为现有 `InputSampleV2`。
3. 复用既有 emitter thread 发出 `tablet-event-v2`。
4. 前端继续通过 tablet store 消费事件。

### 4.3 文件级改动范围

- `src-tauri/src/input/backend.rs`
  - `InputSource` 扩展 `MacNative`。
- `src-tauri/src/input/mod.rs`
  - 注册并导出 mac 原生后端模块。
- `src-tauri/src/input/macos_backend.rs`（新增）
  - 实现 `TabletBackend`。
- `src-tauri/src/commands.rs`
  - 后端枚举增加 mac native 分支。
  - 平台选择与回退逻辑扩展。
- `src/stores/tablet.ts`
  - 状态字面量与诊断映射补充 mac native。
- `src/components/SettingsPanel/index.tsx`
  - 显示 mac native 的 active backend/source。

---

## 5. 里程碑

### M0：诊断与基线固化（0.5-1 天）

- 增加调试指标：
  - native packet 数量，
  - 非零 pressure 比例，
  - queue enqueue/dequeue。
- 固化可重复测试脚本：
  - hover 2s、轻压 3s、重压 3s。

交付物：

- 可复现的前后对比诊断快照（设置面板 + 日志）。

### M1：原生事件桥接（2-3 天）

- 实现 mac 原生 tablet 事件采集桥接到 Rust。
- 归一化 pressure/tilt 范围到现有约定。
- 输出初版 `InputSampleV2` 数据流。

交付物：

- macOS + Wacom 下可稳定观察到非零压感流。

### M2：后端集成（1-2 天）

- 将 `MacNativeBackend` 接入 init/start/stop/switch/status 全生命周期。
- 原生初始化失败时回退 `PointerEvent`。

交付物：

- macOS 正常情况下显示 `Active Backend: macnative`。

### M3：前端接线与保护策略（1 天）

- 前端优先使用 backend 流做压感/倾斜动态。
- 指针事件仅保留坐标/UI 兜底用途。
- 增加“后端流缺失/压力平线”告警。

交付物：

- 同一笔刷预设下可见压感变化。

### M4：验证与回归（1-2 天）

- 手工验证矩阵：
  - Wacom 型号，
  - hover/down/move/up 相位，
  - 压感曲线预设。
- 执行 typecheck/lint/测试与输入专项回归。

交付物：

- 验证报告与已知问题清单。

---

## 6. 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| AppKit 事件接入复杂度 | 中 | 先做 M1 独立桥接原型，再并入后端 |
| 时间戳域不一致 | 中 | 继续以 host-time 作为队列延迟统计基准 |
| 不同 Wacom 设备 tilt 字段差异 | 中低 | 后端统一 clamp/normalize，并暴露诊断 |
| UI fallback 语义混淆 | 低 | 明确 backend/source 文案和告警 |

---

## 7. 验收清单

- [ ] macOS 后端可在 Wacom 环境稳定初始化。
- [ ] live diagnostics 压感值随笔压变化。
- [ ] 首笔下压时存在有效 pressure（非固定 0）。
- [ ] Windows WinTab 路径无行为回归。
- [ ] 原生不可用时可自动回退 pointerevent。

---

## 8. 置信度与疑虑

置信度：**0.76（中高）**。

当前主要疑虑：

1. 在当前 Tauri 集成中，AppKit 采集的最佳 hook 点需要 M1 原型验证。
2. 不同 Wacom 型号在同一路径下的 tilt 一致性需实机覆盖验证。
3. 是否需要额外 mac 能力声明（entitlements/capabilities）需在 M1-M2 期间确认。

若 M1 后仍存在不确定性，则先冻结事件 API 形状，并以 feature flag 方式灰度启用，待 M4 验证通过后默认开启。
