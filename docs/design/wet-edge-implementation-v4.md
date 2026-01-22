# Wet Edge 优化方案 v4.0

## 状态: 📝 规划中

**前置文档**: [Wet Edge Implementation v3.0](./wet-edge-implementation-v3.md)

## 1. 问题诊断

当前的 v3 版本使用基于 Alpha 的色调映射 (`Tone Mapping`) 成功模拟了湿边效果，但在 **硬边笔刷 (Hardness > 0.8)** 上出现了明显的**锯齿 (Aliasing)** 和 **黑边 (Dark Halo)** 现象。

### 原因分析

1. **边缘增强过激**：v3 算法对于低 Alpha 像素会应用高达 `2.2x` 的不透明度增强 (`EdgeBoost`)。
2. **硬边 AA 区域过窄**：硬边笔刷的抗锯齿 (AA) 边缘通常只有 1px 宽（Alpha 值如 128, 50 等）。
3. **副作用**：这仅有的 1px 半透明边缘被算法强行加深（变成深色），而笔刷中心区域又被变淡 (`0.45x`)。
4. **视觉结果**：一个半透明的笔触周围出现了一圈极细的深色描边。由于只有 1px 宽且对比度极高，视觉上表现为严重的锯齿和噪点。

## 2. 优化目标

1. **消除硬边锯齿**：在硬边笔刷上禁用或减弱边缘增强，保持边缘平滑。
2. **提升性能**：移除像素级循环中的浮点运算，使用查找表 (LUT)。
3. **优化质感**：引入 Gamma 修正，使软边笔刷的过渡更自然。

## 3. 核心解决方案：基于硬度的动态参数调整

我们需要根据笔刷的 `hardness` 动态调整 `edgeBoost` 参数。

### 3.1 算法改进

原始公式：

```typescript
multiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
```

**改进策略**：

- 当 `hardness` 接近 0 (软边) 时：保持 `edgeBoost = 2.2` (强湿边)
- 当 `hardness` 接近 1 (硬边) 时：将 `edgeBoost` 降低至 `centerOpacity` (无边缘增强，仅整体变淡)

如果 `edgeBoost` 降至与 `centerOpacity` 相等，公式变为：

```typescript
multiplier = center - (center - center) * alpha = center
```

结果就是 `newAlpha = originalAlpha * centerOpacity`。这是一个标准的、平滑的半透明变淡效果，完全保留了原始的抗锯齿特性，**彻底消除黑边锯齿**。

### 3.2 参数映射公式

```typescript
// 伪代码
function getEdgeBoost(hardness: number): number {
  const MAX_BOOST = 1.8;       // Soft brushes
  const CENTER_OPACITY = 0.65; // Center keeps 65% of original opacity
  const MIN_BOOST = 1.4;       // Hard brushes

  // 阈值控制：hardness 0.7 以上开始迅速衰减效果
  if (hardness > 0.7) {
    const t = (hardness - 0.7) / 0.3; // 0.0 -> 1.0
    // 线性插值：从 MAX_BOOST 降到 MIN_BOOST
    return MAX_BOOST * (1 - t) + MIN_BOOST * t;
  }
  return MAX_BOOST;
}
  return MAX_BOOST;
}
```

### 3.3 特殊边界情况：纹理笔刷 (Texture Brushes)

**问题**：纹理笔刷通常使用位图印章，其内部 Alpha 变化丰富。如果在此类笔刷上开启 wet edge，我们通常希望获得完整的边缘增强效果。然而，系统可能会根据 UI 设置传递 `hardness = 1.0` (默认值)，导致 wet edge 效果被错误地关闭（因触发硬边优化）。

**解决方案**：

- 对于 **Texture Brushes**，强制设定传入 Wet Edge Shader 的 `hardness` 为 `0.0`。
- 这确保了纹理笔刷始终应用最大强度的边缘增强 (`maxBoost`) 和 Gamma 修正，保留丰富的纹理细节。

## 4. 性能与画质优化：预计算 LUT

为了支持上述动态调整，同时保持高性能，我们需要引入 **2D LUT** 或者 **缓存机制**。考虑到 `hardness` 在一次描绘中通常不变，我们可以在笔画开始时（`startStroke`）或者参数变更时生成一个 **1D LUT**。

### 4.1 引入 Gamma 修正

在生成 LUT 时加入 Gamma 曲线，让中灰度区域更丰富。

```typescript
// src/utils/WetEdgeLut.ts

export class WetEdgeLut {
  private lut: Uint8Array = new Uint8Array(256);
  private lastHardness: number = -1;
  private lastStrength: number = -1;

  update(hardness: number, strength: number) {
    // 缓存检查
    if (
      Math.abs(hardness - this.lastHardness) < 0.01 &&
      Math.abs(strength - this.lastStrength) < 0.01
    ) {
      return;
    }

    const centerOpacity = 0.45;
    // 动态计算 EdgeBoost
    const targetBoost = 2.2;
    const effectiveBoost =
      hardness > 0.6
        ? targetBoost * (1 - (hardness - 0.6) / 0.4) + centerOpacity * ((hardness - 0.6) / 0.4)
        : targetBoost;

    // 确保硬边完全回归平缓 (Safety clamp)
    const finalBoost = hardness > 0.95 ? centerOpacity : effectiveBoost;

    for (let i = 0; i < 256; i++) {
      const alphaNorm = i / 255;

      // 视觉优化：Gamma 修正 (让软边过渡更有层次感)
      const shapedAlpha = Math.pow(alphaNorm, 1.4);

      // 核心 Tone Mapping
      const multiplier = finalBoost - (finalBoost - centerOpacity) * shapedAlpha;

      let wetAlpha = i * multiplier;

      // 强度混合
      wetAlpha = i * (1 - strength) + wetAlpha * strength;

      this.lut[i] = Math.min(255, Math.round(wetAlpha));
    }

    this.lastHardness = hardness;
    this.lastStrength = strength;
  }

  get(alpha: number): number {
    return this.lut[alpha];
  }

  getTable(): Uint8Array {
    return this.lut;
  }
}
```

## 5. 实现步骤

### 步骤 1: 扩展 StrokeBuffer 接口

修改 `StrokeBuffer` 类，使其能够接收当前笔刷的 `hardness` 参数。

**File**: `src/utils/strokeBuffer.ts`

```typescript
class StrokeBuffer {
  // ...
  public setBrushParams(hardness: number, strength: number) {
    this.wetEdgeLut.update(hardness, strength);
  }
  // ...
}
```

### 步骤 2: 集成 LUT 到渲染循环

替换原有的浮点计算逻辑。

**File**: `src/utils/strokeBuffer.ts`

```typescript
private applyWetEdgeEffect(): void {
    const lut = this.wetEdgeLut.getTable();
    // ... 遍历 dirtyRect ...
    const alpha = this.bufferData[idx + 3];
    if (alpha > 0) {
        this.wetEdgeBuffer[idx + 3] = lut[alpha];
        // RGB 保持不变
    }
}
```

### 步骤 3: 连通 Frontend 传输链路

确保 `BrushEngine` 或 `accumulate` 调用时将 `hardness` 传递给 `StrokeBuffer`.

## 6. 预期效果对比

| 场景         | v3 (当前)                | v4 (优化后)            | 备注                          |
| ------------ | ------------------------ | ---------------------- | ----------------------------- |
| **硬边笔刷** | 边缘有明显黑圈/锯齿      | 边缘平滑，均匀半透明   | 类似 Photoshop Hard Round Wet |
| **软边笔刷** | 渐变线性，稍显生硬       | 渐变更有体积感 (Gamma) | 视觉质量提升                  |
| **性能**     | 每次像素执行数次浮点运算 | 查表 (Array Access)    | 大分辨率下显著提速            |

## 总结

v4 方案并未推翻 v3，而是完善了 v3 在极端情况（硬边）下的表现，并引入了工业界标准的 LUT 优化手段。这套方案完全可行且低风险。
