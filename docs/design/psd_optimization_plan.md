# PSD 加载优化方案

## 1. 现状分析

### 1.1 Benchmark 数据解读修正

用户观察到 "IPC Transfer"（IPC传输）时间 (375ms) 与 "Backend Subtotal"（后端处理总耗时）时间 (371ms) 几乎一致。
**诊断结论：** 这并非实际的传输延迟，而是**统计方式带来的误解**。

- 前端测量的是 `IPC Transfer = 结束时间 - 开始时间`。
- 这个时间段**包含**了后端处理的时间。
- 因此，此时的 Benchmark 报告实际上重复计算了后端的耗时。
- **实际的 IPC 传输耗时** 可能仅在 `< 5ms` 左右。

### 1.2 实际瓶颈

1.  **后端阻塞 (Backend Blocking)：** `load_project` 命令会等待**所有**图层解码、缩放并缓存完成后，才向前端返回数据。
    - 对于一个包含 100 个图层的文件，用户必须等待所有 100 个图层都处理完毕才能看到界面。
2.  **前端串行加载 (Frontend Serial Loading)：** `window.__loadLayerImages` 使用 `for (const ... of ...) await ...` 循环遍历图层。
    - 这导致了**串行**的图片请求。
    - 即使后端处理很快，前端也人为地引入了延迟（请求图层1 -> 渲染 -> 请求图层2 -> 渲染...）。

## 2. 优化策略

### 第一阶段：快速优化 (Frontend)

#### 并行图层获取 (Parallel Layer Fetching)

修改 `src/components/Canvas/index.tsx`，将图层图片的获取改为并行执行。
虽然浏览器对并发连接数有限制（HTTP/1.1 限制通常为 ~6），但 `project://` 是 Tauri 拦截的自定义协议，应该能支持更高的并发度。

```typescript
// 当前实现 (串行)
for (const layer of layers) {
  await load(layer);
}

// 优化后 (并行)
await Promise.all(layers.map((layer) => load(layer)));
```

### 第二阶段：流式架构 (Backend + Frontend)

为了实现“秒开”体验，我们需要将**结构解析**与**像素解码**解耦。

#### 新的工作流：

1.  **步骤 1：解析结构 (极快)**
    - 后端读取文件并解析 PSD 头部信息（对应 Benchmark 的 Phase 1 & 2，耗时 ~2-3ms）。
    - 立即返回 `ProjectData`，包含图层元数据（名称、透明度、混合模式）。
    - 将图层状态标记为 `status: 'loading'`。
    - **用户体验**：UI 瞬间显示，图层列表和画布尺寸正确，但内容为空或显示占位符。

2.  **步骤 2：立即显示合成图 (可选)**
    - PSD 文件通常存储了一个压平的合成图 (Composite Image)。
    - 后端可以优先加载这张图，作为临时的背景显示。
    - 在各个图层加载完成前，前端先显示这张合成图给用户看。

3.  **步骤 3：后台图层处理**
    - 后端启动后台线程（或使用 Rayon）处理图层。
    - **优先级队列**：优先处理可见图层，然后是隐藏图层。
    - 将处理结果存入 `LayerCache`。

4.  **步骤 4：流式传输至前端**
    - **拉取模式 (最简单)**：前端立即请求 `project://layer/{id}`。
      - 如果图层已准备好 -> 返回字节数据。
      - 如果图层正在处理 -> 阻塞请求直到就绪（或返回 202 Pending）。
    - **推送模式 (事件驱动)**：后端发送 `layer-ready` 事件，携带 `layerId`。
      - 前端监听到事件后，触发该图层的 `fetch` 请求。

## 3. 实施计划

### 3.1 后端变更 (`src-tauri/`)

1.  **重构 `load_psd`**：
    - 拆分为 `parse_psd_structure` (同步) 和 `process_layers_async` (异步/后台)。
    - `LayerData` 增加新字段：`status: Loaded | Pending`。
2.  **更新 `LayerCache`**：
    - 处理并发写入（目前已使用 `RwLock`，符合要求）。
    - 增加挂起请求的通知机制（CondVar 或 Event？）。

### 3.2 前端变更 (`src/`)

1.  **状态管理更新**：
    - 更新 `Layer` 接口以支持 `isLoading` 状态。
    - 处理“部分”项目加载的情况。
2.  **画布渲染**：
    - 为加载中的图层显示加载转圈或占位符。
    - 实现“合成预览”图层，在图层准备好之前置顶显示。

## 4. 建议时间表

1.  **Day 1**：修复 Benchmark 报告 & 实现前端并行获取（第一阶段）。
2.  **Day 2**：设计 `parse_psd_structure` 拆分与后台处理的原型。
3.  **Day 3**：实现前端的 "Loading" 状态与异步事件处理。
