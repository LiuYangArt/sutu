# Rust CPU 笔刷性能优化方案 v2.0

> **状态**: 📝 规划中
> **前置文档**: [rust-cpu-brush-engine.md](./rust-cpu-brush-engine.md)
> **目标**: 解决大笔刷/软笔刷性能问题 + 实现 Wet Edge

## 1. 问题诊断

### 1.1 用户反馈

| 问题 | 状态 | 根因 |
|-----|------|-----|
| 小笔刷硬边圆头速度快了 | ✅ P0 已修复 | IPC 批处理 + spawn_blocking |
| 大笔刷很慢 | ❌ 性能瓶颈 | 每次 stamp 都计算 exp() + 标量合成 |
| 软笔刷越软越慢 | ❌ 性能瓶颈 | extent 3x 扩张 → 像素量 9x |
| Wet Edge 无效 | ❌ 功能缺失 | 参数链路断裂 + 未实现 |

### 1.2 性能瓶颈分析

**像素填充率爆炸**:
- 小笔刷 (20px): 面积 ≈ 1,200 像素
- 大笔刷 (500px): 面积 ≈ **785,000 像素**
- 软笔刷 extent 3x: 面积 ≈ **2,250,000 像素**

**当前流程 (慢)**:
```
┌─────────────────────────────────────────────────────────────┐
│                    render_soft_dab() 流程                    │
├─────────────────────────────────────────────────────────────┤
│  1. Extent 计算                                              │
│     extent_mult = 1.0 + fade  (最大 3.0)                    │
│     → 500px 软笔刷实际处理 1500x1500 = 2.25M 像素           │
│                                                              │
│  2. Mask 生成 ← 每次都算 exp() ❌ (最昂贵的操作)            │
│     process_row_avx: 虽然 SIMD 但每帧都重算                 │
│                                                              │
│  3. 像素合成 ← 标量循环 ❌                                  │
│     for (col, &mask_shape) in mask_row.iter() {             │
│         // 单线程处理百万像素                                │
│     }                                                        │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 Wet Edge 链路断裂

```
前端 wetEdge 参数
    ↓
useBrushRenderer.ts (有值)
    ↓
rustBrushReceiver.ts (未传递) ❌
    ↓
commands.rs rust_brush_input (无参数) ❌
    ↓
streaming.rs stamp_dab (无参数) ❌
    ↓
soft_dab.rs render_soft_dab (无实现) ❌
```

---

## 2. 优化方案

### 2.1 优先级排序

| 优先级 | 任务 | 预期收益 | 复杂度 |
|-------|------|---------|-------|
| **P0** | Mask Caching (预计算缓存) | **5-10x 提速** ⭐⭐⭐⭐⭐ | 中 |
| **P1** | SIMD 混合 (替代标量循环) | 额外 2-4x | 中 |
| **P2** | Rayon 多核并行 (大笔刷) | 额外 2-4x | 中 |
| **P3** | 动态 SyncConfig (大笔刷降频) | 减少 IPC | 低 |
| **P4** | Wet Edge 完整实现 | 功能恢复 | 中 |

### 2.2 P0：Mask Caching (收益最大) ⭐⭐⭐⭐⭐

**核心思想**: 不要每帧都算 `exp()`，预计算 Mask 后只做内存拷贝 + 简单混合。

**当前问题**:
```rust
// 每次 stamp_dab 都在对几十万个像素实时计算 exp(-dist^2)
// 这是极其昂贵的操作
```

**优化方案**:
```rust
// 新增 Mask 缓存结构
struct MaskCache {
    // Key: (radius_bucket, hardness_bucket) -> Value: Alpha Buffer (0..255)
    cache: HashMap<(u32, u32), Arc<Vec<u8>>>,
}

impl StreamingBrushEngine {
    fn get_cached_mask(&mut self, radius: f32, hardness: f32) -> Arc<Vec<u8>> {
        // 1. 量化 radius (每 2px 或 5px 分一个桶，大笔刷不敏感)
        let r_bucket = (radius / 2.0).round() as u32;
        let h_bucket = (hardness * 100.0) as u32;
        let key = (r_bucket, h_bucket);

        if let Some(mask) = self.mask_cache.get(&key) {
            return mask.clone();  // 缓存命中，直接返回
        }

        // 2. 生成 Mask (昂贵操作，但只做一次)
        let real_radius = r_bucket as f32 * 2.0;
        let mask = generate_gaussian_mask(real_radius, hardness);

        let arc = Arc::new(mask);
        self.mask_cache.insert(key, arc.clone());
        arc
    }
}
```

**渲染循环变成**:
```rust
// 之前: 每像素计算 exp()
// 之后: 简单的整数乘加
Color = BrushColor * MaskAlpha + BgColor * (1 - MaskAlpha)
```

**预期收益**: 移除 `exp()` 计算后，性能提升 **5-10 倍**。

### 2.3 P1：SIMD 混合

**目标**: 将标量合成循环改为 AVX SIMD 并行处理

```rust
fn blend_mask_simd(
    dest: &mut [u8],
    dest_w: usize,
    mask: &[u8],        // 从 P0 缓存获取
    mask_w: usize,
    mask_h: usize,
    offset_x: i32,
    offset_y: i32,
    color: (u8, u8, u8),
    opacity: f32
) {
    // AVX2 可以一次处理 32 个字节
    // 遍历 mask 的每一行，批量读取 mask 值
    // 乘以 color 和 opacity，叠加到 dest 上
}
```

**预期收益**: 额外 **2-4x** 提速。

### 2.4 P2：Rayon 多核并行 (大笔刷)

**适用场景**: 大笔刷 (radius > 64px)

```rust
use rayon::prelude::*;

fn render_large_dab_parallel(
    buffer: &mut [u8],
    width: usize,
    dab_rect: Rect,
    mask: &[u8],  // 从 P0 缓存获取
    color: (u8, u8, u8),
) {
    let rows: Vec<usize> = (dab_rect.top..dab_rect.bottom)
        .map(|y| y as usize)
        .collect();

    // 使用 Rayon 并行遍历行
    rows.par_iter().for_each(|&y| {
        // 每行独立处理，无锁竞争
        // SIMD 混合一行
    });
}
```

**注意**: 小笔刷不要开多线程，线程切换开销会变慢。阈值建议 `radius > 64.0`。

**预期收益**: 大笔刷额外 **2-4x** 提速。

### 2.5 P3：动态 SyncConfig

**问题**: 500px 笔刷每秒同步 60 次 = 60MB/s，IPC 拥挤。

**方案**:
```rust
// 动态调整同步策略
let area = dirty_width * dirty_height;
if area > 200 * 200 {
    self.sync_config.max_ms = 32;  // 大笔刷 30fps
} else {
    self.sync_config.max_ms = 16;  // 小笔刷 60fps
}
```

### 2.6 P4：Wet Edge 完整实现

**实现路径**:

1. **IPC 层添加参数**
```rust
// commands.rs
pub async fn rust_brush_input(
    // ... 现有参数 ...
    wet_edge: f32,  // 新增：0.0-1.0
) -> Result<(), String>
```

2. **引擎层添加参数**
```rust
// streaming.rs
pub fn stamp_dab(
    // ... 现有参数 ...
    wet_edge: f32,
) -> bool
```

3. **LUT 计算逻辑** (移植自 TS wet-edge-implementation-v4.md)
```rust
pub fn build_wet_edge_lut(hardness: f32, strength: f32) -> [u8; 256] {
    let center_opacity = 0.45;
    let target_boost = 2.2;

    // 硬笔刷自适应：降低 edge boost 防止锯齿
    let effective_boost = if hardness > 0.6 {
        let t = (hardness - 0.6) / 0.4;
        target_boost * (1.0 - t) + center_opacity * t
    } else {
        target_boost
    };

    let mut lut = [0u8; 256];
    for i in 0..256 {
        let alpha_norm = i as f32 / 255.0;
        let shaped = alpha_norm.powf(1.4);  // Gamma 修正
        let multiplier = effective_boost - (effective_boost - center_opacity) * shaped;
        let wet_alpha = (i as f32 * multiplier * strength + i as f32 * (1.0 - strength))
            .round()
            .clamp(0.0, 255.0);
        lut[i] = wet_alpha as u8;
    }
    lut
}
```

4. **应用 LUT** (SIMD 优化)
```rust
pub fn apply_wet_edge_lut(
    buffer: &mut [u8],
    dirty_rect: &Rect,
    lut: &[u8; 256],
) {
    // SIMD 优化的 Alpha 重映射
    for y in dirty_rect.top..dirty_rect.bottom {
        for x in dirty_rect.left..dirty_rect.right {
            let idx = (y * width + x) * 4 + 3;
            buffer[idx] = lut[buffer[idx] as usize];
        }
    }
}
```

---

## 3. 实施计划

### Phase 1：P0 Mask Caching (1 天) ⭐ 最重要

1. 在 `streaming.rs` 中添加 `MaskCache` 结构
2. 实现 `get_cached_mask()` 方法
3. 修改 `stamp_dab()` 使用缓存 Mask
4. 性能基准测试

### Phase 2：P1 SIMD 混合 (1 天)

1. 实现 `blend_mask_simd()` 函数
2. 替换标量合成循环
3. 性能基准测试

### Phase 3：P2 Rayon 并行 (0.5 天)

1. 添加 `rayon` 依赖
2. 实现 `render_large_dab_parallel()`
3. 添加 radius 阈值判断

### Phase 4：P3 动态 SyncConfig (0.5 天)

1. 根据 dirty area 动态调整 `max_ms`

### Phase 5：P4 Wet Edge (1 天)

1. 添加 IPC 参数链路
2. 实现 `build_wet_edge_lut()`
3. 实现 `apply_wet_edge_lut()`
4. 前端集成

---

## 4. 文件修改清单

| 文件 | 修改内容 |
|-----|---------|
| `src-tauri/src/brush/streaming.rs` | 添加 `MaskCache`, 修改 `stamp_dab()` |
| `src-tauri/src/brush/soft_dab.rs` | 添加 `blend_mask_simd()`, `apply_wet_edge_lut()` |
| `src-tauri/src/commands.rs` | `rust_brush_input` 添加 wet_edge 参数 |
| `src-tauri/Cargo.toml` | 添加 `rayon = "1.8"` |
| `src/utils/rustBrushReceiver.ts` | BrushParams 添加 wetEdge |

---

## 5. 验证方法

### 5.1 性能基准

```rust
// criterion benchmark
fn bench_render_soft_dab(c: &mut Criterion) {
    // 测试场景
    // - 500px 软笔刷 (hardness=0) 单次渲染
    // - 目标: < 5ms (当前 50ms+)
}
```

### 5.2 功能验证

| 场景 | 验证点 |
|-----|-------|
| 500px 软笔刷 | 延迟 < 10ms, 视觉效果正确 |
| 连续绘制 | Mask Cache 命中率 > 95% |
| Wet Edge | 效果与 TS 版本一致 |
| 硬笔刷 + Wet Edge | 无锯齿/黑边 |

---

## 6. 预期效果

| 指标 | 当前 | P0 后 | P1 后 | P2 后 | 总计 |
|-----|------|-------|-------|-------|------|
| 500px 软笔刷延迟 | 50ms+ | **5-10ms** | **3-5ms** | **1-3ms** | **10-50x** |
| Wet Edge | ❌ 无效 | ❌ | ❌ | ❌ | ✅ (P4) |

---

## 7. 总结

**性能瓶颈 90% 在 Rust CPU 端的像素计算上，10% 在 IPC/JS。**

**核心优化思路**:
1. **P0 Mask Caching** - 移除 `exp()` 计算，只做一次，后续全是内存拷贝 ⭐⭐⭐⭐⭐
2. **P1 SIMD 混合** - AVX2 一次处理 32 字节
3. **P2 Rayon 并行** - 大笔刷多核处理
4. **P4 Wet Edge** - 恢复功能完整性

**只要把 `exp()` 拿掉，换成预计算的数组查表，性能至少提升 5-10 倍。**
