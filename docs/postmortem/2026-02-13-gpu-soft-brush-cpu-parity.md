# GPU 软边笔刷与 CPU 基线偏差复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并完成代码级验证

## 背景

在 `tests/visual/gpu-cpu-comparison.html` 的软边参数下（如 `hardness=0.5`），GPU 结果出现明显“串珠/发灰”感，和 CPU 参考渲染差异较大。  
该问题直接影响 GPU-first 路径与 CPU fallback 的手感一致性。

## 现象

1. CPU 笔触中段连续、密实。
2. GPU 同轨迹下中段明显偏灰，dab 分离感强。
3. 差异图（Diff）在整条笔画内部大面积发红，而非只在边缘。

## 根因

根因不是采样点或 spacing，而是 **CPU 与 GPU 使用了不同的软边数学模型**：

1. CPU `MaskCache`（`maskType=gaussian`）已是新模型：  
   `硬度实心核心 + 指数衰减 + 末端 feather`，且软边外延到 `1.8x radius`。
2. GPU `computeBrush.wgsl` 仍使用旧 `erf` 软边公式，核心区在 `hardness=0.5` 时衰减过快。
3. GPU 早剔除/包围盒半径按旧逻辑计算，和 CPU 的软边外延不一致，进一步放大视觉偏差。

结论：这是典型的“同名参数（hardness）跨实现语义漂移”。

## 修复

### 1) 统一软边核函数

将 `src/gpu/shaders/computeBrush.wgsl` 的 `compute_mask` 改为与 CPU 对齐：

1. `normDist <= hardness` 保持满强度核心。
2. 核心外使用 `exp(-2.3 * t^2)` 衰减。
3. `maxExtent=1.8`，末端 `featherWidth=0.3` 平滑收尾。

### 2) 统一有效半径

将 GPU 的 `calculate_effective_radius` 与 TS 侧 `calculateEffectiveRadius` 同步：

1. 硬边：`radius * 1.1`（保持 AA 带）
2. 软边：`radius * 1.8`（匹配 CPU mask 覆盖范围）

涉及文件：

1. `src/gpu/shaders/computeBrush.wgsl`
2. `src/gpu/types.ts`

## 验证

1. `pnpm -s typecheck` 通过。
2. `pnpm -s test src/utils/__tests__/maskCache.softnessProfile.test.ts` 通过。
3. 公式级对比脚本（CPU 新模型 vs GPU 新模型）`max profile diff = 0`。

## 经验沉淀

1. **GPU/CPU 一致性问题，先比公式再比画面**：先确认核函数与半径策略是否同源，再看截图。
2. **参数名一致不代表行为一致**：`hardness`、`gaussian` 这类参数必须绑定“可验证的数学定义”。
3. **可视化对比页需要“公式级回归”兜底**：仅靠图像 diff 会被多因素噪声干扰。
4. **软边模型改动必须同时更新三处**：CPU mask、WGSL mask、TS effective radius。

## 后续防回归建议

1. 增加 GPU 软边 profile 单测（抽样半径剖面对齐 CPU 参考曲线）。
2. 在 `tests/visual/gpu-cpu-comparison.html` 增加固定参数基线快照（至少覆盖 `hardness=0.5`）。
3. 在文档中维护“笔刷参数 -> 数学定义”对照表，避免实现漂移。
