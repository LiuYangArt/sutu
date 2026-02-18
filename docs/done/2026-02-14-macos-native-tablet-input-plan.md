# macOS 原生压感输入落地计划（默认启用版）

> 日期：2026-02-14  
> 状态：Implemented（代码落地完成，待实机回归）  
> 负责人：Input Pipeline

## 摘要
已在现有 WinTab/PointerEvent 架构下新增 `MacNativeBackend`，macOS 默认走原生 `NSEvent` tablet 数据，复用 `tablet-event-v2` 与前端绘制链路。  
策略已按既定决策落地：`macOS 默认启用`、`Full 范围（pressure + tilt + proximity + rotation）`、`老用户 pointerevent 自动迁移到 macnative（一次性）`。

## 已落地项

### P0. 后端能力接入（Rust）
- [x] 新增 `src-tauri/src/input/macos_backend.rs` 并实现 `TabletBackend`。
- [x] 通过 `WebviewWindow::with_webview` 在主线程安装 `NSEvent` 本地监视器。
- [x] 监听 `TabletPoint`、`TabletProximity` 与必要鼠标相位事件（Down/Dragged/Up/Cancel）。
- [x] 固化事件转换：
  - `pressure`: clamp `[0,1]`
  - `tilt`: `tilt()*90` 后 clamp `[-90,90]`
  - `rotation`: 归一化到 `[0,360)`
  - `proximity`: `isEnteringProximity()` -> `ProximityEnter/Leave`
  - `device_time_us`: `timestamp()*1_000_000`
  - `host_time_us`: `current_time_us()`
- [x] `start/stop` 语义与监视器生命周期已实现（可重复启动/卸载）。
- [x] `stream_id=3`（与 WinTab=1、PointerEvent=2 区分）。

### P1. 命令层与选择策略（Rust）
- [x] `BackendType` 新增 `MacNative`（序列化值 `macnative`）。
- [x] `TabletState` 新增 `macnative: Option<MacNativeBackend>`。
- [x] `active_backend/start/switch/select` 纳入 MacNative。
- [x] 平台默认：
  - Windows: `WinTab`
  - macOS: `MacNative`
  - 其他: `PointerEvent`
- [x] 请求后端跨平台归一化 + `fallback_reason` 保留。
- [x] fallback 顺序：
  - macOS: `MacNative -> PointerEvent`
  - Windows: `WinTab -> PointerEvent`
  - Auto: 按平台优先级执行
- [x] “WinTab 专属回退”已泛化为“原生后端回退”（`WinTab | MacNative`）。

### P2. 模块导出与依赖（Rust）
- [x] `src-tauri/src/input/mod.rs` 导出 `MacNativeBackend`。
- [x] `src-tauri/src/input/backend.rs` 新增 `InputSource::MacNative`（序列化值 `mac_native`）。
- [x] `src-tauri/Cargo.toml` 新增 macOS 依赖：`objc2`、`objc2-app-kit`、`objc2-foundation`、`block2`。
- [x] 非 macOS 通过 stub 保持编译可用（返回 backend unavailable 语义）。

### P3. 前端接线泛化
- [x] 新增统一判断：原生流后端 = `wintab | macnative`。
- [x] Canvas 输入链路中 WinTab 特判已泛化：
  - `src/components/Canvas/usePointerHandlers.ts`
  - `src/components/Canvas/useRawPointerInput.ts`
  - `src/components/Canvas/useStrokeProcessor.ts`
  - `src/components/Canvas/inputUtils.ts`
  - `src/components/Canvas/index.tsx`
- [x] 坐标链路保持不变：仍以 PointerEvent 坐标为准，仅覆盖 pressure/tilt/rotation。
- [x] `src/stores/tablet.ts`、`src/components/SettingsPanel/index.tsx`、`src/components/TabletPanel/index.tsx` 扩展 `macnative` 文案与选项。
- [x] Settings “Backend Switch” 按平台显示 `Use Mac Native / Use PointerEvent`（macOS）。

### P4. 设置迁移
- [x] 新增一次性迁移标记：`tablet.backendMigratedToMacNativeAt`。
- [x] macOS 条件迁移：
  - `loaded.tablet.backend === 'pointerevent'`
  - 且迁移标记不存在
  - 首次加载自动改为 `macnative` 并写入时间戳
- [x] 标记存在后不再强制覆盖用户后续手动选择。
- [x] 新安装默认 backend（macOS）为 `macnative`。

### P5. 诊断与文档
- [x] 诊断模板已更新为“平台原生后端（WinTab / MacNative）”表述：
  - `docs/testing/tablet-input-v2-diagnostic-template.md`
- [x] 本计划文档状态已更新为可执行落地版。

## 关键改动文件
- `src-tauri/src/input/backend.rs`
- `src-tauri/src/input/mod.rs`
- `src-tauri/src/input/macos_backend.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/Cargo.toml`
- `src/stores/tablet.ts`
- `src/stores/settings.ts`
- `src/components/SettingsPanel/index.tsx`
- `src/components/TabletPanel/index.tsx`
- `src/components/Canvas/usePointerHandlers.ts`
- `src/components/Canvas/useRawPointerInput.ts`
- `src/components/Canvas/useStrokeProcessor.ts`
- `src/components/Canvas/inputUtils.ts`
- `src/components/Canvas/index.tsx`
- `src/components/Canvas/__tests__/inputUtils.test.ts`
- `src/stores/__tests__/settings.test.ts`
- `docs/testing/tablet-input-v2-diagnostic-template.md`
- `docs/plans/2026-02-14-macos-native-tablet-input-plan.md`

## 待完成验证
- [ ] `pnpm -s test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] macOS + Wacom 手工矩阵（hover/轻压/重压/倾斜/rotation/proximity/fallback/迁移一次性）
- [ ] Windows WinTab 回归矩阵
