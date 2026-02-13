# Texture 混合模式对比图生成

## 目的

使用同一张纹理、同一条 procedural 软边圆笔笔触，生成多公式并排对比图，用于快速判断混合模式是否接近 Photoshop 预期。

> 说明：该对比图默认对应 `Texture Each Tip = Off` 的“连续 stroke alpha 语义”分析；如果要验证 `Texture Each Tip = On`，需要单独按 per-dab 语义建脚本对照。

当前脚本支持 3 个模式：

1. `subtract`（默认）
2. `linearHeight`
3. `height`

其中：

- `subtract` 输出 3 个 Subtract 候选公式（历史行为）
- `linearHeight` 输出 3 个候选：当前实现 + Krita Linear Height(Photoshop) 两种变体
- `height` 输出 3 个候选：当前实现 + Krita Height(Photoshop) 两种变体

`subtract` 默认公式：

1. `A' = clamp(A - d*T, 0, 1)`
2. `A' = A * clamp(1 - d*T, 0, 1)`
3. `A' = clamp(A - d*T*A^g, 0, 1)`

## 脚本位置

`scripts/debug/generate-texture-blend-compare.mjs`

## 快速使用

```bash
node scripts/debug/generate-texture-blend-compare.mjs --mode subtract --texture debug_output/pat_decoded/pat5_sparthtex01.png --output debug_output/texture_formula_compare/subtract_formula_compare_canvas_hires.png
```

## 常用参数

- `--texture`：纹理路径（支持相对仓库根目录或绝对路径，绝对路径需在仓库内）
- `--output`：输出 PNG 路径
- `--mode`：`subtract | linearHeight | height`（默认 `subtract`）
- `--panel-width`：单栏宽度，默认 `1280`
- `--panel-height`：单栏高度，默认 `920`
- `--depth`：深度 `0~1`，默认 `0.78`
- `--gamma`：仅 `subtract` 模式第三公式的 `g`，默认 `0.62`
- `--scale`：纹理采样缩放，默认 `0.55`
- `--invert`：是否反相纹理（`true/false` 或 `1/0`），默认 `true`
- `--brightness`：亮度，默认 `0`
- `--contrast`：对比度，默认 `0`
- `--stroke`：`curve` 或 `line`，默认 `curve`

## 示例

```bash
# 线性笔触版本（更容易看边缘）
node scripts/debug/generate-texture-blend-compare.mjs --texture debug_output/pat_decoded/pat5_sparthtex01.png --output debug_output/texture_formula_compare/subtract_formula_compare_line.png --stroke line

# 更高分辨率
node scripts/debug/generate-texture-blend-compare.mjs --texture debug_output/pat_decoded/pat5_sparthtex01.png --output debug_output/texture_formula_compare/subtract_formula_compare_5k.png --panel-width 1600 --panel-height 1100

# Linear Height（你当前关注）
node scripts/debug/generate-texture-blend-compare.mjs --mode linearHeight --texture debug_output/pat_decoded/pat5_sparthtex01.png --output debug_output/texture_formula_compare/linear_height_formula_compare_line.png --stroke line

# Height
node scripts/debug/generate-texture-blend-compare.mjs --mode height --texture debug_output/pat_decoded/pat5_sparthtex01.png --output debug_output/texture_formula_compare/height_formula_compare_line.png --stroke line
```

## 复用到其它混合模式

后续比较其它模式时，优先复用同一脚本和同一纹理/笔触。这样能排除输入差异，避免“看起来像，但其实是采样条件不同”。

当前模式公式定义在脚本中的 `buildFormulaSet()`，按同样格式新增条目即可。
