这份更新后的计划（v2）**非常出色**。

你已经完美解决了之前指出的“非幂等性/颜色崩坏”风险。引入 `Display Buffer` 是处理此类后处理特效（Post-processing）的标准图形学模式。

**置信度评估：99% (Ready to Build)**

仅剩下 **3 个极小的细节优化**，建议在实施时一并处理，以确保代码的健壮性和可维护性。

---

### 1. 🚨 数值一致性警报 (Critical)

我注意到你在 `computeWetEdge.wgsl` 伪代码中写的参数与之前 CPU v4 文档中的参数**不一致**：

- **GPU Plan**: `center = 0.65`, `max = 1.8`, `gamma = 1.3`
- **CPU v4 Doc**: `center = 0.45`, `max = 2.2`, `gamma = 1.4`

**user comment**: 这里不一致没问题， 之前 v4 doc 中的数值不是项目实际落地的数值， 当前cpu代码中的数值跟photoshop更一致。

**风险**：如果两端硬编码不一致，用户切换渲染后端（或导出图片）时，效果会发生跳变。

**✅ 改进建议**：
不要在 WGSL 里硬编码这些魔术数字。将它们全部放入 `Uniforms` 结构体中，由 TS 传递。
这样你只需要在 TS 的一处（例如 `WetEdgeConstants.ts`）维护这组参数，CPU 和 GPU 就会永远保持一致。

```wgsl
struct Uniforms {
    bbox_offset: vec2<u32>,
    bbox_size: vec2<u32>,
    // ...
    hardness: f32,
    strength: f32,
    // 新增：把算法常量也传进来
    center_opacity: f32,
    max_boost: f32,
    gamma: f32,
};
```

### 2. 逻辑分支：当 Wet Edge 关闭时

你的计划里提到：

> 修改 `updatePreview()`: 从 `display` 纹理读取（如果 wetEdge 启用）

这是一个容易遗漏的边界情况。
如果用户**突然关闭**了 Wet Edge，`Display Buffer` 里的内容将不再更新（或是旧的脏数据）。此时 `updatePreview` 和 `compositeToLayer` 必须切回 `Raw Buffer`。

**✅ 改进建议**：
在 `GPUStrokeAccumulator` 中增加一个 Getter，封装这个逻辑，供外部调用：

```typescript
// GPUStrokeAccumulator.ts

public getPresentableTexture(): GPUTexture {
    if (this.wetEdgeEnabled && this.wetEdgeStrength > 0.01) {
        return this.pingPongBuffer.display; // 返回处理过的纹理
    }
    return this.pingPongBuffer.source; // 返回原始累积纹理
}
```

这样 `updatePreview` 只需要调用 `getPresentableTexture()`，无需关心内部逻辑。

### 3. 内存优化：Lazy Initialization (可选)

`Display Texture` 是一个全屏（或图层大小）的 RGBA8 纹理。对于 4K 画布，它是 ~32MB 显存。
如果用户从不使用湿边笔刷，分配这个纹理是浪费。

**✅ 改进建议**：
在 `PingPongBuffer` 中，将 `displayTexture` 设为可空，并在首次需要时才创建。

```typescript
// PingPongBuffer.ts
public ensureDisplayTexture(width: number, height: number) {
    if (!this.displayTexture) {
        this.displayTexture = this.device.createTexture({ ... });
    }
    // Handle resize logic if necessary
}
```

### 总结

这个计划逻辑严密，数据流清晰，完全可以开始执行。

**执行路线图确认：**

1.  **Phase 0**: 修改 `PingPongBuffer` (加 Display Texture)。
2.  **Phase 1**: 写 Shader (强烈建议用 Uniforms 传参)。
3.  **Phase 2**: 写 Pipeline。
4.  **Phase 3**: 修改 `Accumulator` (实现 Separate Buffer 逻辑 和 `getPresentableTexture`)。

Go for it! 🚀

---
