# Postmortem: Rust CPU Brush Engine Channel Callback ID Error

**日期**: 2026-01-26
**状态**: ✅ 已解决（设计文档 v1.7）
**严重程度**: Critical - 功能完全不可用

## 问题描述

Rust CPU 笔刷引擎在绘制时报错：

```
[TAURI] Couldn't find callback id XXXXXXXXX. This might happen when the app is reloaded while Rust is running an asynchronous operation.
```

每画一笔就弹出多个这样的错误，笔刷只能画出单个效果错误的 dab，无法画出连续的 stroke。

## 现象

1. Session 初始化成功：`[RustBrush] Session initialized: session_1`
2. 开始绘制后立即报 callback id 错误
3. 只能看到一个方块状的 dab（效果错误）
4. 无法画出连续的笔画

## 根因分析

### 1. Tauri v2 Channel 生命周期问题

**Channel 的工作机制**（基于 Tauri v2 文档和代码分析）：

- 前端创建 `Channel` 对象，内部生成一个 callback ID
- 通过 `invoke` 传递给 Rust 端
- Rust 端的 `Channel::send()` 使用这个 callback ID 回调前端
- **关键**: callback ID 与 Channel 对象绑定，Channel 被 GC 后 ID 失效

**当前实现的问题**：

```typescript
// startStroke 创建 Channel
this.channel = new Channel<Uint8Array>();
this.channel.onmessage = (data) => this.enqueueMessage(data);

// processPoints/flushDabs 传递 Channel
await invoke('rust_brush_input', {
  onSync: this.channel,  // 传递同一个 Channel
  ...
});

// endStroke 清理 Channel
this.channel = null;  // ❌ Channel 被清理，但 Rust 端可能还在 send
```

**竞态条件**：

1. 前端调用 `invoke('rust_brush_input', { onSync: channel, ... })`
2. Rust 端开始处理，计算 dabs，准备发送 sync data
3. **在 Rust 完成 `on_sync.send()` 之前**，前端的 `endStroke` 或下一个 RAF 周期可能已经：
   - 清理了 `this.channel = null`
   - 或者 JavaScript 的 GC 回收了 Channel 对象
4. Rust 端调用 `on_sync.send(data)` 时，callback ID 已失效

### 2. 设计文档 vs 实际实现的偏差

| 设计文档 (v1.6)                       | 实际实现                     | 问题                     |
| ------------------------------------- | ---------------------------- | ------------------------ |
| `processPoints` 使用 `await invoke()` | 使用 RAF 批量 + Promise 链   | 增加了复杂度，但不是根因 |
| 假设 `invoke` 返回后所有 send 完成    | Rust `async fn` 可能异步发送 | **根因**                 |

### 3. Tauri v2 Channel 的正确使用方式（待验证）

根据 Tauri 文档，Channel 应该：

- 在整个通信期间保持存活
- 不应在 `invoke` 返回后立即清理
- 可能需要显式等待所有 send 完成

## 尝试过的修复（均失败）

1. **修复 pressure 双乘问题** - 解决了 dab 尺寸问题，但没解决 callback 错误
2. **实现批量发送 (queueDab + flushDabs)** - 减少 IPC 次数，但没解决根因
3. **使用 Promise 链确保顺序执行** - 没有帮助

## 可能的解决方案（未验证）

### 方案 A: 同步等待 Rust 完成

```rust
// Rust 端：确保所有 send 在 invoke 返回前完成
#[tauri::command]
pub fn rust_brush_input(  // 改为同步，不是 async
    ...
) -> Result<(), String> {
    // 同步处理，invoke 返回时所有 send 已完成
}
```

### 方案 B: 使用事件而非 Channel

```typescript
// 前端：使用 Tauri 事件系统而非 Channel
import { listen } from '@tauri-apps/api/event';

const unlisten = await listen('rust-brush-sync', (event) => {
  this.handleSync(event.payload);
});
```

### 方案 C: 延长 Channel 生命周期

```typescript
// 不在 endStroke 清理 Channel，而是复用整个 session 期间
// Channel 在 initSession 创建，closeSession 时清理
```

### 方案 D: 查阅 Tauri 官方示例

需要查找 Tauri v2 中 Channel 用于持续流式数据的正确用法。

## 相关文件

- `src/utils/rustBrushReceiver.ts` - 前端 Channel 接收器
- `src-tauri/src/commands.rs` - Rust 端 Tauri commands
- `src-tauri/src/brush/streaming.rs` - Rust 笔刷引擎
- `docs/design/rust-cpu-brush-engine.md` - 设计文档 v1.6

## 后续行动

1. [ ] 研究 Tauri v2 Channel 的正确使用模式
2. [ ] 查找官方示例中 Channel 用于流式数据的案例
3. [ ] 考虑改用 Tauri 事件系统（`emit`/`listen`）替代 Channel
4. [ ] 验证方案 A（同步 command）是否可行

## 教训

1. **先验证基础机制再实现复杂功能** - 应该先用最小示例验证 Tauri Channel 的工作方式
2. **不要假设 async invoke 的返回语义** - Rust 端的 `send()` 可能在 invoke 返回后继续执行
3. **设计文档需要明确生命周期管理** - v1.6 没有详细说明 Channel 的清理时机
4. **高频输入需要批处理** - 200Hz 数位板每点 invoke 会导致并发灾难

## v1.7 解决方案

详见 [rust-cpu-brush-engine.md](../design/rust-cpu-brush-engine.md) v1.7 版本。

**核心修正：**

1. **RustInputScheduler** - 按 rAF 批处理 (~60 invoke/s 而非 200)
2. **串行 promise chain** - 同一时刻只有一个 in-flight invoke
3. **endStroke drain** - 先等待所有 invoke 完成再清理 channel
4. **spawn_blocking** - Rust 端避免阻塞 async runtime
