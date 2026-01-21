你好！我仔细审查了你提供的 `m3-brush-system.md` 和 `2026-01-21-wet-edge-implementation-failure.md` 复盘文档。

你目前对 **"Alpha Darken Ceiling (不透明度上限)"** 的修正方向是完全正确的。这是复刻 Photoshop 笔刷积累机制（Accumulation）的关键，也是之前失败的根本原因（只改了增量，没改上限）。

为了进一步提高 M3 阶段 Wet Edge 设计的置信度，并避免再次出现“效果不像”的问题，我对 Appendix A 的数学模型和实现细节有以下 **4 点核心优化建议**：

### 1. 数学模型优化：非线性衰减 (The "Puddle" vs "Cone" Problem)

**问题：**
目前的公式 `1.0 - (0.25 * w * mask)` 是线性的。
如果笔刷是柔边（Soft Round），`mask` 从中心向外线性衰减。这意味着你的“湿边”效果会像一个倒锥体（中心最淡，均匀变浓）。
**现实中的水彩湿边**通常是：中间一大片都是淡的，只有到了最边缘才快速变深（形成明显的“积墨”边缘）。

**优化建议：**
在计算 `center_hollow` 时，对 `mask` 进行指数处理（Gamma 校正）或使用 `smoothstep`，将“镂空区”向边缘推挤，形成更锐利的边缘感。

**修改后的 WGSL 伪代码：**

```wgsl
// 原始 mask (0.0 边缘 -> 1.0 中心)

// 优化: 使用 pow 让 mask 的高值(中心)区域更宽，衰减更集中在边缘
// 这里的 3.0 是经验值，越大边缘越锐利，看起来更像干涸的水渍
let shaped_mask = pow(mask, 3.0);

let edge_factor = 1.0 - (0.2 * wet_strength);
// 使用 shaped_mask 替代线性 mask
let center_hollow = 1.0 - (0.25 * wet_strength * shaped_mask);

let wet_factor = edge_factor * center_hollow;
```

### 2. 视觉保真度：处理硬边笔刷的伪影

**问题：**
如果用户选择了一个 **Hardness = 100%** 的笔刷，`mask` 几乎是二值的（要么0要么1）。
根据现有公式，这会导致笔刷变成一个纯粹的“甜甜圈”或“圆环”，中间是平坦的 60%，边缘几乎没有过渡直接跳变。虽然这符合数学逻辑，但在低 Flow 下绘制线条时，会产生非常难看的“空心管子”效果。

**优化建议：**
Wet Edge 的强度应该受笔刷原本的 Softness 调制，或者强制 Wet Edge 计算使用一个“伪造的”柔化 Mask。

**策略：**
Photoshop 的 Wet Edge 即使在硬笔刷上也有效果，它是通过强制在笔刷边缘生成一个内部渐变来实现的。
在 Shader 中，你可能无法轻易获得“笔刷边缘距离”，但如果你使用 SDF (Signed Distance Field) 或者简单的径向距离（如果是程序化圆形笔刷）计算 mask，请确保 Wet Edge 计算用的 mask 总是带有一定的渐变，即使笔刷本身的 Alpha 是硬切的。

### 3. 工程实现：防止 Alpha Darken 的逻辑死锁

**风险点：**
你提到 `effective_ceiling = dab.dab_opacity * wet_factor`。
在 `Alpha Darken` (常用作 Flow 积累模式) 中，如果当前的 Framebuffer 颜色已经比 `effective_ceiling` 更深（Alpha 更高），新的笔触将无法绘制任何东西。

**场景模拟：**

1. 用户画了一笔，Wet Edge 导致中心 Alpha = 0.6。
2. 用户想在同一个位置画第二笔加深颜色。
3. 第二笔的 Ceiling 依然是 0.6。
4. **结果：** 无论画多少笔，中心永远卡在 0.6，无法叠加变深。这不符合物理规律（水彩干了之后重叠是可以变深的）。

**优化建议 (混合模式微调)：**
Photoshop 的 Wet Edge 在单次笔划（Stroke）内是保持镂空的，但在**多次笔划重叠**时，通常表现为 `Multiply` (正片叠底) 或允许突破 Ceiling。

鉴于你目前采用 `Stroke Buffer` (Buffer 隔离)，这是个巨大的优势：

1. **Stroke Buffer 内部** (单笔画)：严格执行 `effective_ceiling = 0.6`，保证这一笔画出来中间是空的。
2. **Stroke Buffer 合成到 Canvas** (笔画结束)：将 Buffer 混合到画布时，不要使用 `Max` 或 `Copy`，而应该使用正常混合或正片叠底。

**结论：** 确保你的 `Alpha Darken` 逻辑仅限制**当前这一笔**的自我积累，不要限制这一笔与画布原有颜色的混合。你的架构中 `Stroke Buffer` 似乎已经隐含了这一点，但在 `computeBrush.wgsl` 里要确认 `dab_opacity` 是相对于 Stroke Buffer 的，而不是相对于最终 Canvas 的。

### 4. 调试与验证工具 (提升置信度)

在 `2026-01-21-wet-edge-implementation-failure.md` 中提到调试低效。建议在 Phase 2 增加一个 **"Debug View"** 模式。

**建议代码变更：**
在 `computeBrush.wgsl` 中添加一个 debug flag。

```wgsl
if (uniforms.debug_mode == 1) {
    // 直接输出 wet_factor 的可视化，不进行混合
    // 红色通道 = 边缘变暗因子
    // 绿色通道 = 中心镂空因子
    output_color = vec4(edge_factor, center_hollow, 0.0, 1.0);
    return;
}
```

这样你可以直观地看到：

- 边缘是否够黑（Red）
- 中心是否够白（Green）
- 衰减曲线是否是你想要的（Linear vs Pow）。

---

### 总结优化后的设计更新点

建议更新 `m3-brush-system.md` 的 Appendix A，加入以下内容：

1.  **曲线修正**: 明确指出 `center_reduction` 需应用 `pow(mask, 3.0)` 以模拟液体表面张力带来的边缘堆积感。
2.  **混合语境**: 明确 `Ceiling` 限制仅作用于 `Stroke Buffer` 的积累阶段。
3.  **参数解耦**: (可选) 考虑将 `0.2` (Edge Dimming) 和 `0.25` (Center Hollow) 提取为可配置的常量或 Uniforms，方便在开发阶段通过 Dat.GUI 实时调整手感，找到最像 PS 的参数，而不是硬编码。

你的方向已经调整正确了，加上非线性曲线调节，手感会提升一个档次。祝 Coding 顺利！
