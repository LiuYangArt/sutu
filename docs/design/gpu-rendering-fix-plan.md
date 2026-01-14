# GPU 笔刷渲染修复计划

> **日期**: 2026-01-14
> **状态**: 待实施
> **目标**: 修复 GPU 渲染的视觉一致性问题，消除闪烁

---

## 当前状态

| 目标                           | 状态      | 说明                        |
| ------------------------------ | --------- | --------------------------- |
| 大笔刷性能提升                 | ✅ 已达成 | 500px+ 笔刷性能明显优于 CPU |
| 视觉效果与 CPU 一致            | ❌ 未达成 | 算法差异导致视觉缺陷        |
| WYSIWYG（Preview = Composite） | ❌ 未达成 | 抬笔时有闪烁                |

---

## 问题列表

### P0: Shader 算法不一致

| 问题               | 现象                 | 根因                          | 修复方案                |
| ------------------ | -------------------- | ----------------------------- | ----------------------- |
| Gaussian 曲线错误  | 软笔刷边缘过渡不柔和 | `distfactor` 缺少 `/dab_size` | 修正公式                |
| 白色边缘线         | 快速绘画时出现白边   | 预乘 Alpha 处理不当           | 严格预乘逻辑 + 守卫代码 |
| hardness=100 渐变  | 边缘应纯色却有渐变   | AA 带用归一化距离             | 改用物理像素计算        |
| **颜色空间不一致** | 深色混合结果差异     | CPU=sRGB, GPU=Linear          | 强制 sRGB 空间混合      |

### P1: Preview/Composite 数据流不一致

| 问题     | 现象               | 根因                                     |
| -------- | ------------------ | ---------------------------------------- |
| 抬笔闪烁 | 画完一笔时画面闪烁 | Preview/Composite 使用不同 readback 时机 |

---

## 修复计划

### Phase 0: 测试环境 + GPU/CPU 切换功能

> [!IMPORTANT]
> 先有测试，后有修复。GPU/CPU 切换功能既是开发工具，也是用户功能。

#### 0.1 GPU/CPU 渲染切换功能

**目的**: 方便开发时直接对比 GPU/CPU 渲染效果，同时作为用户功能提供回退选项。

**实现方案**:

1. **Store 扩展** (`src/stores/tool.ts`):

   ```typescript
   // 新增状态
   renderMode: 'auto' | 'gpu' | 'cpu';  // auto = 自动选择（大笔刷用GPU）
   setRenderMode: (mode) => void;
   ```

2. **UI 组件** (`src/components/BrushPanel/`):
   - 在笔刷设置面板底部添加切换开关
   - 三个选项: Auto（默认）/ GPU / CPU
   - 当前模式指示器

3. **渲染层集成** (`src/components/Canvas/`):
   - 根据 `renderMode` 选择 `StrokeAccumulator` 或 `GPUStrokeAccumulator`
   - `auto` 模式: `brushSize > 200 ? GPU : CPU`

#### 0.2 视觉对比测试

| 步骤            | 说明                      | 产出                                   |
| --------------- | ------------------------- | -------------------------------------- |
| 创建测试页面    | 并排显示 GPU/CPU 渲染结果 | `tests/visual/gpu-cpu-comparison.html` |
| 记录差异基线    | 当前各参数的差异率        | 差异报告                               |
| CI 集成（可选） | Playwright 自动截图对比   | 回归测试                               |

**测试用例**:

- 硬度: `hardness=0.0/0.5/1.0`
- 尺寸: `size=10/100/500`
- 流量: `flow=0.1/0.5/1.0`
- **混合模式**: Normal / Multiply / Overlay（决定是否需要 Grab Pass）
- 边界条件: 画布边缘裁剪

---

### Phase 1: 修复 Shader 算法

#### 1.1 颜色空间对齐（极其关键！）

> [!CAUTION]
> 这是"视觉看起来不对"的隐形杀手。Canvas 2D 在 sRGB 空间混合，GPU 默认可能是 Linear。

**检查项**:

- [ ] 确认 WebGPU Canvas Context 的 `colorSpace` 设置为 `srgb`
- [ ] Shader 中不做 Gamma 转换，直接在 sRGB 空间混合

**配置**:

```typescript
// WebGPU Canvas 配置
canvas.getContext('webgpu', { colorSpace: 'srgb' });
```

#### 1.2 修复 `distfactor` 计算

```diff
- let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade);
+ let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * in.dab_size);
```

#### 1.3 使用 Storage Buffer 查表（替代数学近似）

> [!TIP]
> 不用纹理采样（有线性插值误差），用 Storage Buffer 完全复制 CPU 查表逻辑。

```wgsl
@group(0) @binding(3) var<storage, read> gaussian_table: array<f32>; // 1024 个值

fn get_gaussian(dist: f32) -> f32 {
    let index = u32(clamp(dist, 0.0, 1.0) * 1023.0);
    return gaussian_table[index]; // 与 CPU 查表完全一致
}
```

#### 1.4 预乘 Alpha 守卫代码

> [!WARNING]
> 永远不要输出 `rgb > a` 的非法预乘值。

```wgsl
// 混合后强制修正
out.rgb = min(out.rgb, vec3(out.a));
```

**混合公式确认**:

```wgsl
// 标准预乘混合：Target = Source + Dest * (1 - Source.a)
// 注意：输入已预乘，不要再乘 alpha！
```

#### 1.5 修复 AA 带计算

```wgsl
let pixel_size = 1.0 / in.dab_size;
let half_pixel = pixel_size * 0.5;
```

---

### Phase 2: 重构 Preview 架构

**方案: WebGPU Overlay + Canvas 2D Underlay**

```
┌─────────────────────────────────────────┐
│     WebGPU Canvas (透明，顶层)          │
│     - 显示当前笔触，无 readback          │
├─────────────────────────────────────────┤
│     Canvas 2D (底层)                    │
│     - 显示已完成图层                     │
│     - EndStroke 时合成笔触               │
└─────────────────────────────────────────┘
```

#### 2.1 Grab Pass 机制（支持复杂混合模式）

> [!IMPORTANT]
> Multiply 等混合模式需要背景参与，否则 Preview 和 Composite 结果不一致。

**流程**:

1. `PointerDown`: 检测混合模式
   - Normal 模式：不需要背景
   - 其他模式：从 Canvas 2D 抓取笔刷包围盒区域到 `bg_texture`
2. `PointerMove`: Shader 中 `out = Blend(bg_texture, brush_color)`
3. `PointerUp`: 回读并合成（或覆盖）

---

### Phase 3: 验证

| 测试项     | 方法                   | 通过标准   |
| ---------- | ---------------------- | ---------- |
| 像素一致性 | GPU vs CPU 单 dab 对比 | 误差 ≤ ±2  |
| WYSIWYG    | Preview 与抬笔后对比   | 完全一致   |
| 性能       | 大笔刷 benchmark       | 优于 CPU   |
| 混合模式   | Multiply/Overlay 测试  | 无视觉跳变 |

---

## 执行优先级

1. **立即**:
   - Phase 0.1: GPU/CPU 切换功能（方便后续调试）
   - Phase 1.1: 颜色空间对齐
2. **短期**:
   - Phase 1.2-1.5: Shader 修复
   - Phase 0.2: 视觉对比测试
3. **中期**:
   - Phase 2: Overlay 架构 + Grab Pass
4. **持续**:
   - Phase 3: 验证 + CI 集成

> [!CAUTION]
> **不要急于追求性能指标，先死磕"像素一致性"**。

---

## 参考文件

| 文件                                                                                                              | 说明                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| [maskCache.ts](file:///f:/CodeProjects/PaintBoard/src/utils/maskCache.ts)                                         | CPU 版 Gaussian mask     |
| [strokeBuffer.ts](file:///f:/CodeProjects/PaintBoard/src/utils/strokeBuffer.ts)                                   | CPU 版 StrokeAccumulator |
| [brush.wgsl](file:///f:/CodeProjects/PaintBoard/src/gpu/shaders/brush.wgsl)                                       | GPU shader（需修复）     |
| [tool.ts](file:///f:/CodeProjects/PaintBoard/src/stores/tool.ts)                                                  | 工具状态管理             |
| [gpu-brush-rendering-issues.md](file:///f:/CodeProjects/PaintBoard/docs/postmortem/gpu-brush-rendering-issues.md) | 问题详细分析             |
