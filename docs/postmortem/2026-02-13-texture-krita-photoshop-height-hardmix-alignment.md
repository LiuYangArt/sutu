# Texture HardMix/LinearHeight/Height 对齐修复复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并完成基础回归

## 背景

在 Texture 模式下，`hardMix / linearHeight / height` 与 Photoshop 视觉差异明显：

1. `hardMix` 边缘过硬。  
2. `linearHeight / height` 中心区域仍残留明显纹理，无法形成“中心填满、纹理主要体现在边缘”的效果。  

用户在同参数下与 PS 对照后确认：问题更像“混合公式语义偏差”，不是采样或笔触几何问题。

## 排查结论

1. 现有 `linearHeight / height` 公式属于 `base * f(texture)` 类型，`base≈1` 时仍被 texture 强调制，因此中心不易填满。  
2. Krita 已实现一组 `Photoshop` 命名模式（`Hard Mix Softer (Photoshop) / Linear Height (Photoshop) / Height (Photoshop)`），可作为可验证参考。  
3. 从 Krita 源码确认这些模式在“非 soft-texturing 分支”中都把 `depth` 直接嵌入公式，而不是先算 blend 再统一 `mix(base, blended, depth)`。

## 修复方案

对 `hardMix / linearHeight / height` 统一采用 Krita 的 Photoshop 分支公式（non-soft-texturing）：

1. `hardMix`  
   `out = clamp(3 * (base * depth) - 2 * (1 - blend), 0, 1)`
2. `linearHeight`  
   `M = 10 * depth * base`  
   `out = clamp(max((1 - blend) * M, M - blend), 0, 1)`
3. `height`  
   `out = clamp(10 * depth * base - blend, 0, 1)`

并同步修正作用顺序：

1. `hardMix / linearHeight / height` 视为“公式内已包含 depth”。  
2. 这三种模式不再额外走一次 `mix(base, blended, depth)`，避免 depth 被重复作用。  

## 代码落点

1. GPU：`src/gpu/shaders/computeBrush.wgsl`  
2. GPU：`src/gpu/shaders/computeTextureBrush.wgsl`  
3. CPU fallback：`src/utils/textureRendering.ts`  
4. 单测：`src/utils/textureRendering.test.ts`

## 验证

1. 自动化：`pnpm -s test -- textureRendering` 通过（14/14）。  
2. 自动化：`pnpm -s typecheck` 通过。  
3. 手测：用户确认视觉已对齐预期（`linearHeight / height` 中心填满；`hardMix` 软化后更接近 PS）。

## 经验沉淀

1. **模式名字相同不代表语义相同**：`Height` 系列在不同实现中常有“depth 是否内嵌公式”的差异。  
2. **优先对齐“作用顺序”再调参数**：公式正确但顺序错误（例如 depth 重复作用）仍会产生明显偏差。  
3. **CPU/GPU 必须同构更新**：纹理模式对齐中，任意单链路漂移都会导致验证结论失真。  
4. **先用固定输入做公式对比图，再进 app 手感验收**：可以显著缩短主观调参回合。

