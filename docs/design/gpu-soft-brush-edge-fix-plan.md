# GPU 软笔刷边缘优化方案

> **目标**: 修复 GPU 渲染下软笔刷边缘被裁切（clip）的问题
> **范围**: 仅 GPU 渲染路径
> **置信度**: 95%
> **日期**: 2026-01-15

---

## 问题分析

### 现象
用户反馈：hardness 0~0.6 的软笔刷，blur 边缘被裁切（clip），Gaussian 渐变没有完整展现。

**视觉证据**：在边缘处可以看到一条明显的"硬边界"，Gaussian 渐变在此处被突然截断，而不是平滑衰减到透明。

### 根因分析

**Quad 尺寸计算** (`brush.wgsl` 第 73-75 行):
```wgsl
let fade = (1.0 - instance.hardness) * 2.0;
let extent_multiplier = 1.0 + fade;
let effective_radius = instance.dab_size * extent_multiplier;
```

**Discard 逻辑** (`brush.wgsl` 第 162-167 行):
```wgsl
let dist = length(in.local_uv) * in.extent_multiplier;
if (dist > in.extent_multiplier) {
    discard;
}
```

**问题**: `local_uv` 是 quad 的 UV 坐标，范围 `[-1, 1]`。在 quad 角落处 `length(local_uv) = sqrt(2) ≈ 1.414`，这会超过 1.0 导致额外裁切。

但更关键的问题是：**Gaussian 曲线在 `dist = 1.0`（原始 dab 边界）时可能仍有显著值，需要在 `extent_multiplier` 范围内完整展现。**

当前 extent 计算:
- `hardness=0` → `extent=3.0` (quad 扩展到 3x radius)
- `hardness=0.5` → `extent=2.0`
- `hardness=0.6` → `extent=1.8`

**但 Gaussian 曲线可能需要更大的 extent 才能完全衰减到接近 0。**

---

## 解决方案

### 方案: 仅增大 Vertex Shader 的几何范围

**核心思路**: 只扩大 Quad 的几何尺寸，**不修改 Fragment Shader 的 Gaussian 公式**，避免改变笔刷手感。

**经过 review 确认**：Fragment Shader 中的 `fade` 变量直接参与 Gaussian 曲线的 `center` 和 `distfactor` 计算，修改会导致笔刷视觉软度变化。

```wgsl
// Vertex Shader 修改 (只改几何范围)
// 修改前
let fade = (1.0 - instance.hardness) * 2.0;
let extent_multiplier = select(1.0, 1.0 + fade, instance.hardness < 0.99);

// 修改后: 几何扩展用 2.5 系数，确保最小 extent 为 1.5
let geometric_fade = (1.0 - instance.hardness) * 2.5;  // 仅用于几何扩展
let extent_multiplier = select(1.0, max(1.5, 1.0 + geometric_fade), instance.hardness < 0.99);
```

**Fragment Shader 保持不变**: `fade = (1.0 - in.hardness) * 2.0` 不修改，保持原有 Gaussian 曲线形状。

---

## 实施计划

### Step 1: 修改 Vertex Shader 的几何扩展

**文件**: `src/gpu/shaders/brush.wgsl`

**位置**: 第 73-74 行

```wgsl
// 修改前:
let fade = (1.0 - instance.hardness) * 2.0;
let extent_multiplier = select(1.0, 1.0 + fade, instance.hardness < 0.99);

// 修改后:
let geometric_fade = (1.0 - instance.hardness) * 2.5;
let extent_multiplier = select(1.0, max(1.5, 1.0 + geometric_fade), instance.hardness < 0.99);
```

### Step 2: Fragment Shader 保持不变 ✓

**不修改** `src/gpu/shaders/brush.wgsl` 第 209 行的 `fade` 计算，保持 Gaussian 曲线形状。

### Step 3: 同步修改 TypeScript 的 extent 计算

**文件**: `src/gpu/types.ts`

**位置**: `calculateEffectiveRadius` 函数

```typescript
// 修改前:
const fade = (1.0 - hardness) * 2.0;
return radius * (1.0 + fade);

// 修改后:
const geometricFade = (1.0 - hardness) * 2.5;
return radius * Math.max(1.5, 1.0 + geometricFade);
```

### Step 4: (可选) 添加防御性边缘过渡

**文件**: `src/gpu/shaders/brush.wgsl`

在 discard 逻辑后添加软边缘保险：

```wgsl
// 在接近几何边缘的最后 5% 区域强制淡出，作为保险丝
let edge_safety = smoothstep(in.extent_multiplier, in.extent_multiplier - 0.05, dist);
// 在最终 alpha 输出时应用: out_a *= edge_safety;
```

### Step 5: 验证

1. 运行 `pnpm dev`
2. 测试 hardness=0.0, 0.3, 0.5, 0.6 的软笔刷
3. **关键测试**: 对比修改前后 hardness=0.5，确保只是"边缘变完整了"，而不是"整个笔刷变大或变虚了"
4. 确认边缘不再被裁切

---

## 关键文件

| 文件 | 修改类型 |
|------|----------|
| `src/gpu/shaders/brush.wgsl` | Vertex Shader 几何扩展 (Fragment 不改) |
| `src/gpu/types.ts` | 同步 TypeScript extent 计算 |

---

## 验证方式

1. **视觉对比**: 修改前后截图对比
2. **边缘检查**: 确认 hardness=0.3, 0.5, 0.6 时边缘完整、不被裁切
3. **手感一致性**: 对比 hardness=0.5，确保只是"边缘变完整"而非"笔刷变大或变虚"

---

## 风险评估

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| 性能下降（更大的渲染区域）| 低 | Quad 扩大约 25%，影响可忽略 |
| 笔刷手感变化 | 无 | Fragment Shader 不修改 |
| 与 CPU 渲染差异 | 低 | 用户已明确只优化 GPU |
