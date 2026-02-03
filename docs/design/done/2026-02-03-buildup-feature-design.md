# Buildup 功能设计（v1 / CPU Ground Truth）

复刻 Photoshop 笔刷的 **Build-up (Airbrush Style Build-up)** 效果（v1 先做 CPU 路径，作为 GPU 对齐的 ground truth）。

## 需求理解

Buildup 是一种 airbrush 喷枪风格的效果：即使笔刷在原地持续输入（相同位置、相同压感），也会持续“喷涂/累积”，表现为软边逐步填满。

### 核心行为

| 对比项       | 关闭 Build-up (当前) | 开启 Build-up               |
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

## 技术方案（v1）

### 核心判断

当前 CPU 笔刷的 alpha 混合是 **Alpha Darken / 向 ceiling 指数趋近**：

```ts
// outA = dstA + (ceiling - dstA) * srcAlpha
// srcAlpha = maskValue * flow
```

这个公式本身就具备 build-up 的“中心快速饱和、边缘缓慢填满”的特性：**只要能在原地持续产生新的 dab**，边缘就会逐渐累积到 ceiling。

因此 v1 不引入 additive 线性累积曲线，也不修改 `maskCache.ts` / `textureMaskCache.ts` 的 blending 公式；只解决“原地不出新 dab”的问题。

### 问题根因

1. `BrushStamper.processPoint` 为了解决“起笔大头/压力堆积”问题，会在起笔阶段卡住：
   - 首点不出 dab
   - 未达到 `MIN_MOVEMENT_DISTANCE` 前不出 dab
2. 即使绕过最小位移，如果输入事件不再产生（笔尖静止），也没有机制“按时间持续喷涂”。

### 解决思路（v1）

两层修复（都只在 `buildupEnabled` 时生效）：

1. **BrushStamper**：允许首点产 dab + 0 位移也产 dab，并跳过 `MIN_MOVEMENT_DISTANCE` gate。
2. **StrokeProcessor**：CPU backend（`RenderMode=cpu` / `backend=canvas2d`）下，在 RAF loop 里按时间补点（默认 60Hz），仅当本帧没有真实输入点时触发（避免改变移动笔触的 spacing 手感）。

> v1 仅 CPU 生效：GPU 路径不做同步。

---

## Proposed Changes

### 1. State Management

#### [MODIFY] `src/stores/tool.ts`

添加 `buildupEnabled` 状态与 action，并加入 `persist.partialize`：

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

#### [MODIFY] `src/components/BrushPanel/BrushSettingsSidebar.tsx`

Sidebar checkbox 里加入 `build_up` 的 toggle。

#### [MODIFY] `src/components/BrushPanel/index.tsx`

启用 `build_up` tab，并渲染 `BuildupSettings`。

#### [NEW] `src/components/BrushPanel/settings/BuildupSettings.tsx`

说明文案。

---

### 3. 参数透传（BrushRenderConfig）

#### [MODIFY] `src/components/Canvas/index.tsx`

`getBrushConfig()` 增加 `buildupEnabled`。

#### [MODIFY] `src/components/Canvas/useBrushRenderer.ts`

`BrushRenderConfig` 增加 `buildupEnabled`，并在调用 `stamper.processPoint(...)` / `secondaryStamper.processPoint(...)` 时传入。

---

### 4. Build-up Tick（RAF 补点）

#### [MODIFY] `src/components/Canvas/useStrokeProcessor.ts`

在 RAF loop 里增加 build-up tick：

- 条件：`buildupEnabled && strokeState==='active'`（CPU/GPU 都支持；由 renderer 决定实际 backend）
- 频率：`TARGET_BUILDUP_DABS_PER_SEC = 5`（`MAX_BUILDUP_DABS_PER_FRAME = 1`）
- 位置：`lastInputPosRef ?? lastRenderedPosRef`
- 压力：优先 WinTab `currentPoint.pressure`，否则用 `lastPressureRef`
- 调用：`processBrushPointWithConfig(...)` + `flushPending()`
- 额外：buildup 开启时，`starting` 阶段 replay 会做“近似同点折叠”，并在有后续点时跳过首个 PointerDown 点，避免首 dab 压力不准导致“起笔过重”。

---

### 5. BrushStamper 修改（允许原地出 dab）

#### [MODIFY] `src/utils/strokeBuffer.ts`

- `processPoint(...)` 增加参数 `buildupEnabled?: boolean`
- 行为（仅 buildupEnabled=true）：
  - 首点立即产 1 个 dab
  - 跳过 `MIN_MOVEMENT_DISTANCE` gate
  - 当 `distance ~ 0` 时也产 dab（避免“原地没输出”）

---

## Verification Plan

### 单元测试

#### [NEW] `src/utils/__tests__/brushStamper.buildup.test.ts`

```typescript
describe('BrushStamper build-up', () => {
  it('does not emit dabs while stationary when buildup disabled');
  it('emits dabs while stationary when buildup enabled');
});
```

### 手动验证

1. Render Mode 切到 `cpu`
2. 软边笔刷 + 50% opacity（flow 任意）
3. **关闭 Build-up**：戳住不动 ≥ 1s → 基本无变化
4. **开启 Build-up**：戳住不动 ≥ 1s → 边缘逐步填满（中心不继续变深）

---

## 风险评估

| 风险           | 缓解措施          |
| -------------- | ----------------- |
| GPU 路径不同步 | 本次只做 CPU 实现 |
| 回归现有行为   | 添加单元测试      |

**置信度**：8/10
