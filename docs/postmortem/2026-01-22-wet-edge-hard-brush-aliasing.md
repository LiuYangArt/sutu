# Postmortem: Wet Edge 硬边笔刷锯齿优化 (v4)

## 日期
2026-01-22

## 问题描述
Wet Edge v3 实现在**硬边笔刷 (hardness > 0.8)** 上出现明显的**锯齿和黑边**现象。

### 现象
- 硬边笔刷边缘出现 1px 深色描边
- 对比度过高，视觉表现为锯齿/噪点
- 与 Photoshop Hard Round Wet 效果差距明显

## 根因分析

### 问题本质
1. **边缘增强过激**: v3 对低 alpha 像素应用 `2.2x` 的 edgeBoost
2. **硬边 AA 区域过窄**: 硬边笔刷的抗锯齿边缘只有 ~1px 宽
3. **副作用**: 这仅有的 1px 半透明边缘被强行加深，形成深色环

### 公式分析
```typescript
// v3 公式 - 固定参数
const edgeBoost = 2.2;
const centerOpacity = 0.45;
const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
```

对于硬边笔刷：
- 中心 alpha=255 → multiplier=0.45 → 变淡 ✓
- 边缘 alpha≈128 (仅 1px) → multiplier≈1.3 → 被加深 ✗

这 1px 被加深的边缘在高对比度下表现为锯齿。

## 解决方案: 基于硬度的动态参数调整

### 核心思路
根据 `hardness` 动态调整 `edgeBoost`，让硬边笔刷的边缘增强逐渐降低。

### 实现

#### 1. 新增 LUT 预计算机制
```typescript
private wetEdgeLut: Uint8Array = new Uint8Array(256);
private wetEdgeLutValid: boolean = false;
```

#### 2. 动态 edgeBoost 计算
```typescript
private buildWetEdgeLut(hardness: number, strength: number): void {
  const centerOpacity = 0.65;  // PS-matched: 中心保留 65%
  const maxBoost = 1.8;        // 软边最大增强
  const minBoost = 1.4;        // 硬边最小增强

  let effectiveBoost: number;
  if (hardness > 0.7) {
    // 硬边过渡区: 线性插值到 minBoost
    const t = (hardness - 0.7) / 0.3;
    effectiveBoost = maxBoost * (1 - t) + minBoost * t;
  } else {
    effectiveBoost = maxBoost;
  }

  // 硬边跳过 gamma，保留原始 AA
  const shapedAlpha = hardness > 0.7 ? alphaNorm : Math.pow(alphaNorm, 1.3);
  // ... LUT 构建
}
```

#### 3. LUT 查表替代浮点运算
```typescript
private applyWetEdgeEffect(): void {
  const lut = this.wetEdgeLut;
  // ...
  const newAlpha = lut[originalAlpha]!;  // O(1) 查表
}
```

## 参数调优过程

| 迭代 | centerOpacity | maxBoost | minBoost | 结果 |
|-----|---------------|----------|----------|------|
| v4.0 | 0.45 | 2.2 | =center | 锯齿消除，但边缘完全不可见 |
| v4.1 | 0.45 | 2.2 | 1.2 | 边缘太弱 |
| v4.2 | 0.6 | 2.0 | 1.5 | 中心仍太透明 |
| v4.3 | 0.65 | 1.8 | 1.4 | 接近 PS 效果 ✓ |

### 关键发现
- **PS 中心 opacity 约 60-65%**，而非之前假设的 45%
- 硬边需要保留 `minBoost > 1.0` 才能有可见边缘效果
- Gamma 校正应在硬边时跳过，保护原始 AA 梯度

## 效果对比

| 场景 | v3 | v4 |
|-----|----|----|
| 硬边笔刷 | 边缘有明显黑圈/锯齿 | 边缘平滑，保持可见 |
| 软边笔刷 | 有效 | 更自然 (gamma 修正) |
| 性能 | 每像素浮点运算 | LUT 查表 O(1) |

## 架构改进

### 新增字段
```typescript
private wetEdgeHardness: number = 0;
private wetEdgeLut: Uint8Array = new Uint8Array(256);
private wetEdgeLutValid: boolean = false;
```

### 接口变更
`beginStroke(hardness, wetEdge)` 现在实际使用 hardness 参数来构建 LUT。

## 关键洞察

### 为什么 v3 在软边有效但硬边失败
- **软边**: alpha 梯度宽 (10-50px)，增强分散在大区域，视觉平滑
- **硬边**: alpha 梯度窄 (~1px)，增强集中在极窄边缘，形成锐利对比

### 解决问题的本质
不是"修复锯齿"，而是**让硬边笔刷回归均匀缩放**：
```typescript
// 当 edgeBoost = centerOpacity 时
multiplier = center - (center - center) * alpha = center
// 结果: newAlpha = originalAlpha × center (均匀缩放，保留 AA)
```

## 文件变更
- `src/utils/strokeBuffer.ts`: LUT 机制 + 动态参数

## 未来改进
- 可考虑将 centerOpacity/maxBoost/minBoost 暴露为高级用户参数
- GPU 路径同步此优化
