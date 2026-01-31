# 2026-01-31 Dual Brush Implementation & Debugging Postmortem

## 1. Summary

Dual Brush 功能通过将第二种笔刷纹理作为遮罩应用到主笔刷上，创造出丰富的纹理效果。在实现过程中，我们遇到了从渲染管线、状态管理到资源加载的一系列问题。本文档总结了这些问题及其解决方案。

## 2. Issues & Root Causes

### 2.1 硬边笔刷 Dual Brush 失效

**现象**: 软笔刷（Soft Round）可以应用 Dual Brush 效果，但硬笔刷（Hard Round）完全无效果。
**原因**: 为了优化性能，渲染管线中为 `hardness === 100` 的笔刷设置了 Fast Path (`stampHardBrush`)，直接跳过了 mask 生成和混合逻辑，因此完全忽略了 Dual Brush 的配置。

### 2.2 切换副笔刷后第一笔黑色 (First Stroke Black)

**现象**: 选中一个新的副笔刷 Preset，画第一笔时笔触全黑（矩形块），第二笔恢复正常。
**原因**:

1.  **预加载缺失**: 点击 Preset 时仅更新了 ID，渲染器在第一笔绘制时才去请求纹理。
2.  **异步加载延迟**: `setTexture` 是异步的，第一帧渲染时纹理尚未这就，也未返回 Promise 给渲染循环等待，导致使用了未初始化的纹理数据（全黑或全白）。
3.  **错误的预加载尝试**: 初期尝试使用 `new Image().src = "project://..."` 进行预加载，但后端返回的是 LZ4 压缩的二进制数据（`image/x-gray-lz4`），浏览器无法直接识别，导致 CORS 和解码错误。

### 2.3 LocalStorage Quota Exceeded

**现象**: 切换几次笔刷后，应用报错 `QuotaExceededError`。
**原因**: Zustand Store 在持久化（`partialize`）时，默认保存了整个 `dualBrush` 对象。当加载了纹理后，`texture.data` 包含巨大的 Base64 字符串，迅速撑爆了 5MB 的 LocalStorage 限制。

### 2.4 UI 多选高亮错误

**现象**: 点击某个 imported brush，UI 上会同时高亮显示多个笔刷。
**原因**: 多个 imported brush 可能拥有相同的 UUID（从同一个 ABR 文件不同位置读取，或者文件本身结构导致）。UI 仅使用 `id` 作为 Key 进行高亮判定。

### 2.5 纹理不连续 (Artifacts)

**现象**: 笔刷纹理看起来杂乱无章，原本的图案被打乱。
**原因**: 为了增加随机性，代码中曾引入了 `angle: Math.random() * 360`。对于有方向性的纹理（如排线、毛发），随机旋转破坏了连续性。

## 3. Solutions

### 3.1 渲染管线修复

- 修改 `maskCache.ts` 和 `strokeBuffer.ts`，让 `stampHardBrush` 也能接收 `dualMask` 和 `dualMode` 参数。
- 在 Fast Path 中加入 Dual Brush 的混合逻辑（Alpha Masking）。

### 3.2 预加载与资源管理

- **正确的数据加载**: 使用 `brushLoader.ts` 中的 `loadBrushTexture` 函数，它封装了 fetch -> arrayBuffer -> LZ4 Decompress -> ImageData 的完整流程。
- **预加载逻辑**: 在 `DualBrushSettings` 的 `onClick` 事件中，立即调用 `loadBrushTexture`。
- **State Injection**: 获取到 `ImageData` 后，直接注入到 Zustand Store 的 `dualBrush.texture.imageData` 中。确保渲染器初始化时就能拿到准备好的数据。

### 3.3 存储优化

- 在 `stores/tool.ts` 的 `partialize` 函数中，显式过滤掉 `texture` 字段。
- `dualBrush` 仅持久化配置项（blend mode, size, spacing 等）和 `brushId`，不保存纹理数据。

### 3.4 UI 修复

- 引入 `brushIndex` 字段到 `DualBrushSettings` 接口。
- UI 使用 `brushIndex` 配合 `brushId` 进行唯一选中态判断。

### 3.5 视觉效果回归

- 回退随机角度变更，保持 `angle: 0` 或尊重 ABR 中的设置，确保纹理连续。

## 4. Lessons Learned

1.  **Protocol & Browser Compatibility**: Tauri 的自定义协议虽然强大，但浏览器对非标准 MIME 类型（如自定义的 LZ4 stream）的支持是有限的。不能假设所有 `project://` URL 都能被 `<img src>` 或 `new Image()` 消费。
2.  **State Management for Binary Data**: 大型的二进制数据（WebAssembly Memory, Image Buffers, Base64 Strings）不适合放在需要频繁序列化/持久化的 Store 中。应将它们视为 Runtime Cache，仅在 Store 中保存引用（ID/Path）。
3.  **Performance Optimization Traps**: 过早优化（如 Hard Brush Fast Path）可能会在后续功能扩展（如 Dual Brush）时成为绊脚石。在添加新特性时，必须审查所有的 Fast Path。

## 5. Action Items

- [ ] 全局审查其他 Fast Path（如橡皮擦逻辑），确保没有遗漏类似的混合特性。
- [ ] 考虑将 `ImageData` 缓存层移出 Zustand Store，完全由 `TextureMaskCache` 管理，Store 只存 ID。目前为了解决第一笔黑问题暂时注入了 Store，但这略微违反了"Store only stores serializable state"的最佳实践。
