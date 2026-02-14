# 纹理主笔尖 Hardness 与 Auto Downsample 的 PS 一致性修复

## 日期
2026-02-14

## 问题描述

在 GPU 笔刷压测中发现两类体验偏差：

1. 主笔尖为纹理时，`Hardness` 仍可调整，和 Photoshop 行为不一致（PS 中该项禁用）。
2. `Downsample = Auto` 的触发条件绑定 `hardness < 70 && size > 300`，导致纹理主笔尖在常见 `hardness=100` 下无法触发降采样。

## 影响

- 用户对“纹理笔刷性能优化是否生效”产生误判。
- UI 暴露了对纹理主笔尖无实际意义的参数入口，增加理解成本。
- Auto 策略与真实性能热点（大尺寸纹理笔尖）不匹配。

## 根因分析

### 根因 1：参数语义与笔刷类型耦合不清

`Hardness` 主要针对 procedural 圆头边缘软化，但 UI 没有根据主笔尖类型做能力收敛，导致“可调但无效”的状态。

### 根因 2：Auto 降采样触发逻辑过度依赖 hardness

旧逻辑只基于 `hardness + size`，未区分“主笔尖是否纹理”。结果是纹理主笔尖的大尺寸场景被错误排除在 Auto 之外。

## 修复方案

### 1) UI 与 PS 对齐：纹理主笔尖禁用 Hardness

- 文件：`src/components/BrushPanel/settings/BrushTipShape.tsx`
- 规则：`brushTexture !== null` 时禁用 Hardness 滑杆。
- 显示：禁用态显示 `--`，避免误导为可编辑有效值。
- 设计选择：仅禁用，不强制把内部 hardness 改为 100，保持切回圆头后的原有参数连续性。

### 2) Auto 规则改为“按主笔尖类型分流”

- 文件：`src/gpu/GPUStrokeAccumulator.ts`
- 新增纯函数：`computeAutoDownsampleDecision(...)`
- 规则：
  - `mode !== auto`：不触发
  - `size <= 300`：不触发
  - `主笔尖为纹理 && size > 300`：触发
  - `主笔尖为 procedural && size > 300`：要求 `hardness < 70`

### 3) 文案同步

- 文件：
  - `src/components/BrushPanel/settings/RendererSettings.tsx`
  - `src/components/SettingsPanel/index.tsx`
- 文案更新为：大笔刷自动降采样，procedural 额外要求 hardness < 70。

## Code Simplifier 结果

在实现后做了针对本次改动范围的简化整理：

1. 将 Auto 触发逻辑提炼为纯函数 `computeAutoDownsampleDecision`，降低 UI 状态读取与判定逻辑耦合。
2. 使用语义化局部变量（`isLargeBrush`, `isSoftProceduralBrush`）替代隐式条件串联，提高可读性与测试可达性。
3. 维持行为不变前提下，将规则集中到单点，减少后续修改时的分支散落风险。

## 验证

执行：

```bash
pnpm -s vitest run src/components/BrushPanel/settings/BrushTipShape.test.tsx src/gpu/GPUStrokeAccumulator.downsample.test.ts
```

结果：

- 2 个测试文件通过
- 7 个用例通过

覆盖点：

- 纹理主笔尖时 Hardness disabled
- procedural 时 Hardness 可编辑
- Auto downsample 在纹理/procedural、size、hardness 组合下的判定正确性

## 经验教训

1. “参数可见”不等于“参数有意义”，UI 需要和笔刷模型能力严格对齐。
2. 性能策略规则应围绕真实成本因子建模，避免沿用单一路径的历史阈值。
3. 将策略判断提炼为纯函数，可以显著降低后续回归和误读成本。
