# 原生渲染方案设计（WGPU + WebView 叠加）

**日期**：2026-02-05  
**状态**：设计草案（已对齐）

## 1. 目标与成功标准

### 目标
- **Windows MVP**，为 macOS 可移植性预留约束与接口。
- 画布最低 **4K**，显示以 **2K** 为主。
- **32GB 台式显卡**目标上限 **8K**，**4060 移动版**上限 **4K**。
- **可见层数不设上限**，视觉正确性不因设备配置变化。
- 渲染与笔输入在原生侧，WebView 仅负责 UI。
- 目标性能 **120fps / 输入延迟 < 8ms**。

### 成功标准
- 8K（台式）与 4K（笔记本）长笔画 30s 稳定无停顿。
- 100+ 层可见合成正确，且可见区域合成稳定。
- PNG 导出一致（显示与导出颜色路径一致）。

## 2. 非目标（MVP 不做）

- 不支持 Selection/Mask。
- 不支持复杂笔刷（dual/texture/wet-edge/scatter）。
- 不支持全量混合模式（仅 normal + opacity）。
- 不要求全画布全层纹理常驻显存。

## 3. 核心决策

### 3.1 渲染技术栈
- **Rust + WGPU** 负责渲染与笔刷计算。
- **WebView** 仅负责 UI 与配置面板。
- UI 与渲染通过稳定的命令协议交互，不传像素。

### 3.2 Tile/虚拟纹理
- 画布按 **256 tile** 切分。
- 图层以 tile 集合表达，非活动层不全量常驻。
- **TileResidencyManager** 控制显存常驻与回收。

### 3.3 可见 tile 合成缓存
- `belowComposite` 与 `aboveComposite` 均为 **可见 tile 缓存**。
- 失效条件严格枚举：内容变化、可见性、opacity、blend、顺序。

### 3.4 输入路径
- 笔输入由 **原生侧直接采集**。
- WebView 仅接收 UI 交互事件，不承担笔输入采样。

### 3.5 导入/导出收敛到 Rust
- 导入解析与导出写入均在 Rust 侧完成。
- WebView 只接收元数据（层名、可见性等），不接收像素。

## 4. 架构概览

### 4.1 核心模块
- `NativeRenderCore`：WGPU 设备与渲染主循环。
- `LayerStore`：图层元数据与 tile 结构。
- `TileResidencyManager`：tile 常驻预算与 LRU。
- `StrokeEngine`：笔输入采样与 stroke 计算。
- `Composer`：可见 tile 合成与 display 输出。
- `ExportService`：PNG 导出与未来 PSD 适配。
- `UiBridge`：WebView 命令协议与状态同步。

### 4.2 数据流
- 输入点 → `StrokeEngine` 生成脏 tile 集合。
- `activeScratch` 写入脏 tile（`rgba16float`）。
- `commitStroke()` 采用 **ping-pong** 避免同纹理读写冲突。
- `Composer` 仅对可见 tile 合成并输出显示。
- 导出时对 tile 合成，统一走 `linear -> sRGB8 + dither`。

## 5. 颜色与精度处理

- Layer 与 scratch 在 **线性空间** 混合。
- 显示输出进行线性 → sRGB。
- 导出统一走 GPU pass 后 readback，禁止直接读 layer 原始纹理。

## 6. 导入/导出路径改造

### 6.1 导入
- 继续使用 `psd`/`ora` 解析逻辑。
- 输出目标改为原生侧 **tile 结构**。
- UI 仅获取元数据，不获取像素。

### 6.2 导出
- 新增 `ExportService`，从 tile 组装连续 layer buffer。
- 先统一颜色转换与抖动，再写 PNG。
- 现有 PSD 写入逻辑可复用，但需适配 tile 组装桥接层。

## 7. 窗口与 UI 叠加

- 原生 WGPU 画布为底层窗口。
- WebView 作为透明 UI 叠加层。
- 输入分发由原生侧统一调度，UI 仅消费 UI 区域事件。
- macOS 预留：窗口叠加与输入模块做可替换封装。

## 8. 性能与验证

### 性能指标
- 120fps / 输入延迟 < 8ms。
- 以“可见 tile 数量”作为合成负载指标。

### 验证用例
- 4K/8K 长笔画 30s 稳定性。
- 100+ 层合成正确性。
- PNG 导出一致性验证。
- Tile cache miss 率统计与回收频率。

## 9. 里程碑

### M0：WGPU 基线与设备探测
- 设备能力探测与 4K/8K 分配测试。
- 基础渲染窗口与显示链路打通。

### M1：Tile 基础设施
- 256 tile 切分。
- LRU 常驻与可见 tile 管理。

### M2：基础笔刷与合成
- `activeScratch` 与 commit ping-pong。
- normal + opacity 合成。

### M3：导出路径
- PNG 导出与色彩一致性验证。

### M4：性能与稳定性
- 120fps 目标验证与优化。
- tile 缓存统计与调优。

## 10. 风险与对策

- **窗口叠加兼容性**：抽象 `UiBridge` 与窗口适配层，预留 macOS 实现。
- **Tile miss 过高**：调大常驻预算与预取策略，统计并优化热点。
- **导出耗时**：分 tile 流式导出，后台线程执行。
