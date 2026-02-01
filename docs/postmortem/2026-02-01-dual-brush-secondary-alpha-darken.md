# Dual Brush Secondary 累积方式偏淡问题复盘

## 问题背景

用户反馈：CPU 笔刷在 Dual Brush 场景下，主笔刷比副笔刷更“黑”，即使副笔刷使用相同的 brush tip 作为 Secondary 也偏淡。

## 现象

- 主笔刷（primary）连续 dab 累积更黑。
- Dual Brush 的 secondary（同 tip）整体更浅、密度不足。

## 根因分析

1. **Secondary 仅做 max blending**
   - `stampSecondaryDab()` 使用 `stampToMask()` 写入 `dualMaskAccumulator`。
   - `stampToMask()` 采用“最大值”累积，缺少 Alpha Darken 式逐 dab 叠加。

2. **Secondary 缺少 flow/dabOpacity 参与**
   - Secondary 累积没有逐 dab 的密度增长机制，无法达到主笔刷的黑度趋势。

## 修复方案

- 将 Secondary 的 `stampToMask()` 改为 Alpha Darken 风格累积。
- 采用固定 `flow=1`、`dabOpacity=1` 的行为（B 方案），使 secondary 在多 dab 下更接近主笔刷密度。

涉及文件：
- `src/utils/maskCache.ts`
- `src/utils/textureMaskCache.ts`

## 结果

- Secondary 能随 dab 叠加逐渐变黑。
- 同 tip 情况下，Dual Brush 效果更接近主笔刷密度。

## 遗留风险（记录，不在本次修复中处理）

1. **Secondary 可能过快趋近饱和**
   - 由于固定 `flow=1`/`dabOpacity=1`，在高密度场景下可能更快变“实”。

2. **与 PS 行为的精确一致性待评估**
   - 仅覆盖 CPU 路径的可见一致性，PS 对 secondary 的真实堆叠规则仍需对照采样。

## 经验总结

1. Dual Brush 的 secondary 若只做 max blending，密度会系统性偏淡。
2. 想贴近主笔刷黑度，必须让 secondary 支持逐 dab 的 Alpha Darken 累积。
3. 固定 flow/opacity 是最快验证路径，但后续可考虑提供可控参数。
