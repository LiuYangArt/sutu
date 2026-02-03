# Buildup 功能设计

复刻 Photoshop 笔刷的 **Buildup (Airbrush Style Build-up)** 效果。

## 需求理解

Buildup 是一种 airbrush 喷枪风格的效果：即使笔刷在原地持续输入（相同位置、相同压感），也会持续"扩展"覆盖区域。

### 核心行为

| 对比项       | 关闭 Buildup (当前) | 开启 Buildup                |
| ------------ | ------------------- | --------------------------- |
| 同位置持续戳 | 无变化 (max blend)  | 边缘 alpha 累积             |
| 中心 alpha   | 保持不变            | 保持不变 (不超过 flow 上限) |
| 视觉效果     | 静止                | 软边逐渐"填满"，范围扩大感  |

### 与"多笔叠加"的区别

- **Buildup**：单笔内 alpha 累积，但 opacity 被锁定（不叠加）
- **多笔叠加**：每笔的 alpha 都会与之前笔划叠加，颜色变深

参考示意图：

![Buildup vs 多笔叠加效果对比](../../assets/buildup-reference.png)

---

## 技术方案

### 问题分析

当前 `maskCache.ts` 中的 `blendPixel` 方法使用 **Alpha Darken** 混合：

```typescript
// 当前逻辑：lerp toward ceiling, 但 ceiling 是 dabOpacity
const outA = dstA >= dabOpacity - 0.001 ? dstA : dstA + (dabOpacity - dstA) * srcAlpha;
```

**问题**：当前 `BrushStamper.processPoint` 会过滤掉"没有足够移动"的 pointer 事件，所以即使 Buildup 开启，原地戳也不会生成新的 dab。

### 解决方案

Buildup 开启时，需要确保：

1. **每个 pointer 事件都生成 dab**（即使位置相同）
2. **Alpha 累积使用 additive blend**（而非 max blend）
3. **Alpha 不超过 flow 上限**（保持 opacity 不叠加）

---

## Proposed Changes

### 1. State Management

#### [MODIFY] [tool.ts](file:///f:/CodeProjects/PaintBoard/src/stores/tool.ts)

添加 Buildup 状态和 action：

```diff
interface ToolState {
  wetEdgeEnabled: boolean;
  wetEdge: number;
+ buildupEnabled: boolean;

  setWetEdgeEnabled: (enabled: boolean) => void;
  toggleWetEdge: () => void;
+ setBuildupEnabled: (enabled: boolean) => void;
+ toggleBuildup: () => void;
}
```

---

### 2. UI Component

#### [NEW] [BuildupSettings.tsx](file:///f:/CodeProjects/PaintBoard/src/components/BrushPanel/settings/BuildupSettings.tsx)

类似 `WetEdgeSettings.tsx` 的简单 toggle 开关。

---

### 3. Brush Stamper 修改

#### [MODIFY] [strokeBuffer.ts](file:///f:/CodeProjects/PaintBoard/src/utils/strokeBuffer.ts)

修改 `BrushStamper.processPoint`，Buildup 开启时跳过"minimum movement"检查并持续生成 dab。

---

### 4. Alpha Blending 修改

#### [MODIFY] [maskCache.ts](file:///f:/CodeProjects/PaintBoard/src/utils/maskCache.ts)

Buildup 模式使用 additive blend：

```diff
+ if (buildupMode) {
+   // Buildup: additive blend, ceiling = opacity (not flow)
+   // - flow controls per-dab contribution
+   // - opacity is the maximum alpha ceiling
+   outA = Math.min(opacity, dstA + srcAlpha * flow);
+ } else {
+   outA = dstA >= dabOpacity - 0.001 ? dstA : dstA + (dabOpacity - dstA) * srcAlpha;
+ }
```

> [!IMPORTANT]
> **Opacity vs Flow 的作用**：
>
> - `100% opacity, 50% flow` → 慢慢累积，最终可达完全不透明
> - `50% opacity, 100% flow` → 快速累积，但最多只能到 50% 透明度
>
> 公式：`outA = min(opacity, dstA + srcAlpha * flow)`

---

### 5. 传递 Buildup 参数

- [useBrushRenderer.ts](file:///f:/CodeProjects/PaintBoard/src/hooks/useBrushRenderer.ts)：从 store 读取 `buildupEnabled`
- [strokeBuffer.ts](file:///f:/CodeProjects/PaintBoard/src/utils/strokeBuffer.ts)：`stamp()` 添加 `buildup` 参数
- [textureMaskCache.ts](file:///f:/CodeProjects/PaintBoard/src/utils/textureMaskCache.ts)：同样添加支持

---

## Verification Plan

### 单元测试

#### [NEW] [maskCache.test.ts](file:///f:/CodeProjects/PaintBoard/src/utils/__tests__/maskCache.test.ts)

```typescript
describe('MaskCache blendPixel', () => {
  it('should accumulate alpha in buildup mode');
  it('should clamp alpha to dabOpacity ceiling');
  it('should use max blend in non-buildup mode');
});
```

### 手动验证

1. 软边笔刷 + 50% opacity
2. **关闭 Buildup**：戳住不动 → 无变化
3. **开启 Buildup**：戳住不动 → 边缘填满，中心颜色不变深

---

## 风险评估

| 风险           | 缓解措施          |
| -------------- | ----------------- |
| GPU 路径不同步 | 本次只做 CPU 实现 |
| 回归现有行为   | 添加单元测试      |

**置信度**：8/10
