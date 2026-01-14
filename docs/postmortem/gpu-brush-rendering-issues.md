# GPU 笔刷渲染问题总结

> **日期**: 2026-01-14
> **状态**: 进行中
> **目标**: 解决大笔刷（500px+）CPU 性能瓶颈，同时保持视觉与 CPU 版本完全一致

---

## 背景与现状

### 实现方案
采用 **WebGPU Render Pipeline + GPU Instancing** 方案加速软笔刷渲染：
- 使用 Ping-Pong Buffer 避免 WebGPU 读写冲突
- Alpha Darken 混合在 Fragment Shader 中实现
- GPU Instancing 批量渲染多个 dab

### 目标达成情况

| 目标 | 状态 | 说明 |
|------|------|------|
| 大笔刷性能提升 | ✅ **已达成** | 用户确认大笔触（500px+）性能明显优于 CPU |
| 视觉效果与 CPU 一致 | ❌ **未达成** | 多个算法差异导致视觉缺陷 |
| WYSIWYG（Preview = Composite） | ❌ **未达成** | 抬笔时有闪烁 |

---

## 发现的问题

### 问题 1：Gaussian 曲线计算错误

**现象**
- 软笔刷（hardness < 100）边缘过渡不柔和
- 与 CPU 版本相比，笔触形状有明显差异

**根因**
`distfactor` 计算缺少对 `radiusX`（`dab_size`）的归一化。

**CPU 版本** (`src/utils/maskCache.ts:171`):
```javascript
const distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX);
const physicalDist = normDist * radiusX;
const scaledDist = physicalDist * distfactor;
```

**GPU 版本** (`src/gpu/shaders/brush.wgsl:147`):
```wgsl
let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade);  // ❌ 缺少 * dab_size
let scaled_dist = dist * distfactor;  // dist 是归一化距离 0-1
```

**修复方案**
```wgsl
let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * in.dab_size);
```

---

### 问题 2：白色圆圈边缘线

**现象**
- 快速绘画时出现白色圆圈边缘线
- 特别是在深色背景上画浅色笔触时明显

**根因分析**
- GPU 纹理初始化为 `rgba(0, 0, 0, 0)`
- 当 `dst_a > 0.001` 但 `dst.rgb = (0, 0, 0)` 时
- 颜色混合公式：`dst.rgb + (in.color - dst.rgb) * src_alpha`
- 可能是 Ping-Pong Buffer 的 `copySourceToDest()` 或 Alpha Darken 逻辑问题

**待验证**
1. 检查 `PingPongBuffer.clear()` 是否正确清空
2. 检查颜色混合逻辑是否处理了 `dst` 为未初始化状态

---

### 问题 3：画完一笔闪烁

**现象**
- 抬笔时画面闪烁一下
- Preview 和 Composite 结果不一致

**根因**
Preview 和 Composite 使用不同的数据路径：

```
Preview 路径：GPU Texture → 异步 readback → previewCanvas → 显示
Composite 路径：GPU Texture → 同步 readback → layer
```

两次 readback 时机不同，导致数据不一致。

**正确做法**
- Preview 和 Composite 应该使用相同的单次 readback 结果
- 或者 Preview 直接从 GPU 渲染（WebGPU canvas context），只在 Composite 时 readback

---

### 问题 4：hardness=100 边缘渐变问题

**现象**（已修复）
- hardness=100 时，中间有渐变，应该是纯色圆

**根因**
AA 带计算使用归一化距离而非物理像素：
```wgsl
// 错误：AA 带覆盖半径的 50%
if (edge_dist > -0.5) { mask = 0.5 - edge_dist; }
```

**修复方案**
使用物理像素计算 1px AA 带：
```wgsl
let pixel_size = 1.0 / in.dab_size;
let half_pixel = pixel_size * 0.5;
```

---

## 架构对比

### CPU 实现（参考标准）

```
stampDab() → bufferData (内存，Uint8ClampedArray)
                          ↓
              syncToCanvas() (同步，每 N dabs 一次)
                          ↓
                    previewCanvas
                          ↓
            endStroke() 读取同一 previewCanvas → 合成到 layer
```

**特点**：
- 数据源唯一，Preview = Composite
- 同步操作，无延迟
- 简单可靠

### GPU 实现（当前，有问题）

```
stampDab() → GPU Texture (显存)
                          ↓
              异步 readback (copyTextureToBuffer + mapAsync)
                          ↓
                    previewCanvas (有 1-2 帧延迟)
                          ↓
            endStroke() 再次 readback → 合成到 layer
                          ↑
                    两次 readback 可能不一致 → 闪烁
```

**问题**：
- 异步 readback 导致 Preview 延迟
- 两次 readback 数据可能不一致
- Canvas 2D 无法直接显示 GPU 纹理

### 理想 GPU 实现

```
stampDab() → GPU Texture (显存)
                          ↓
        WebGPU Canvas Context 直接渲染 → 显示 (无 readback)
                          ↓
            endStroke() 单次 readback → 合成到 layer
```

**特点**：
- Preview 无延迟（直接 GPU 渲染）
- 只在 Composite 时 readback 一次
- Preview = Composite

---

## 经验教训

### 1. 先保证正确性，再优化性能
- 应该先用单元测试验证 shader 与 CPU 算法完全一致
- 再进行性能优化和架构替换
- 当前实现跳过了验证步骤，导致多个算法差异

### 2. 架构设计要考虑数据流一致性
- WYSIWYG 要求 Preview 和 Composite 使用相同数据
- 异步操作会破坏一致性，需要精心设计
- 双缓冲、异步更新都会增加复杂度

### 3. GPU readback 是昂贵的
- `copyTextureToBuffer` + `mapAsync` 需要 1-2 帧
- 应该尽量减少 readback 次数
- 考虑使用 WebGPU canvas context 直接渲染，避免 readback

### 4. 渐进式迁移策略
- 不应该一步到位替换整个渲染层
- 应该先验证核心算法（单个 dab 渲染）
- 再验证批处理（多个 dab）
- 最后验证完整流程（插值、压感等）

### 5. 参考实现的重要性
- CPU 版本 (`maskCache.ts`) 是正确的参考
- shader 算法必须逐行对比 CPU 版本
- 常数、公式、边界条件都要一致

---

## 修复计划

### Phase 1：修复 Shader 算法（视觉一致性）

| 步骤 | 说明 |
|------|------|
| 1.1 | 修复 `distfactor` 添加 `/ in.dab_size` |
| 1.2 | 验证 erf 近似函数精度与 CPU 一致 |
| 1.3 | 修复颜色混合逻辑（白色边缘问题） |
| 1.4 | 创建像素对比测试，确保 GPU = CPU |

### Phase 2：解决 Preview/Composite 一致性

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| WebGPU Canvas Context | 直接渲染，无 readback | 需重构显示层 | ⭐⭐⭐⭐⭐ |
| 同步 readback（简化） | 改动小 | 可能有延迟 | ⭐⭐ |
| 双 Canvas 叠加 | 折中 | 复杂度高 | ⭐⭐⭐ |

**推荐方案**：WebGPU Canvas Context
- 创建 `<canvas>` 的 WebGPU context 用于预览
- 直接将 stroke texture 渲染到 WebGPU canvas
- 主 Canvas 2D 用于最终合成和图层显示
- endStroke 时 readback 并合成到图层 Canvas 2D

### Phase 3：测试验证

| 测试项 | 方法 |
|--------|------|
| 像素一致性 | GPU vs CPU 单个 dab 渲染对比，误差 < ±1 |
| WYSIWYG | Preview 与抬笔后结果完全一致 |
| 性能 | 确认 GPU 性能保持优于 CPU |
| 稳定性 | 连续绘画测试 |

---

## 参考文件

| 文件 | 说明 |
|------|------|
| `src/utils/maskCache.ts` | CPU 版 Alpha Darken 和 Gaussian mask（正确参考） |
| `src/utils/strokeBuffer.ts` | CPU 版 StrokeAccumulator（正确参考） |
| `src/gpu/shaders/brush.wgsl` | GPU shader（需修复） |
| `src/gpu/GPUStrokeAccumulator.ts` | GPU 版 StrokeAccumulator（需重构） |
| `src/gpu/resources/PingPongBuffer.ts` | Ping-Pong Buffer 实现 |
| `docs/design/gpu-rendering-strategies.md` | 原始设计文档 |

---

## 下一步

1. **立即修复**：shader 中的 `distfactor` 计算
2. **短期**：设计并实现 WebGPU Canvas Context 方案
3. **长期**：建立完整的像素对比测试体系
