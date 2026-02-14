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

## GPU 空笔画回归检查（Texture Each Tip Off + Dual Off）

用于防回归检查“GPU 在 `Texture Each Tip=Off` 且 `Dual Brush=Off` 时是否出现空笔画”。

脚本位置：

`scripts/debug/replay-texture-eachtip-off-nonempty.mjs`

示例：

```bash
node scripts/debug/replay-texture-eachtip-off-nonempty.mjs --url http://localhost:1420 --capture debug_output/texture_formula_compare/tmp-dual-capture.json --texture debug_output/pat_decoded/pat5_sparthtex01.png
```

通过条件（可调）：

1. `nonZeroAlphaPixels >= --min-nonzero-pixels`（默认 `200`）
2. `alphaSum >= --min-alpha-sum`（默认 `5000`）

## Texture Each Tip=On / Depth Jitter 对照回放

用于固定同一 capture + 同一种子，直接输出 `off / on / jitter` 三列对照，验证：

1. `Texture Each Tip` 语义切换是否生效；
2. `Depth Jitter` 是否体现为每个最终 stamp 的深浅变化；
3. `off-on` 与 `on-jitter` 的差异是否为非零且趋势符合预期。

脚本位置：

`scripts/debug/replay-texture-eachtip-compare.mjs`

快速示例：

```bash
node scripts/debug/replay-texture-eachtip-compare.mjs --url http://localhost:1420 --capture "C:/Users/<you>/AppData/Roaming/com.sutu/debug-data/debug-stroke-capture.json" --texture "debug_output/pat_decoded/pat5_sparthtex01.png" --mode subtract --depth 100 --depth-control 0 --minimum-depth 0 --depth-jitter 35 --seed 424242 --output "debug_output/texture_formula_compare/eachtip_compare"
```

常用参数（新增脚本）：

- `--render-mode`：`gpu | cpu`，默认 `gpu`
- `--mode`：纹理混合模式（如 `subtract/darken/linearHeight`）
- `--depth`：0~100，默认 `100`
- `--depth-control`：Depth Control 枚举（`0=off,1=fade,2=penPressure...`）
- `--minimum-depth`：0~100，默认 `0`
- `--depth-jitter`：0~100，默认 `35`（仅 jitter 场景）
- `--seed`：固定随机种子，保证可重复
- `--diff-threshold`：像素 mismatch 阈值，默认 `4`

输出文件：

1. `*-off.png`
2. `*-on.png`
3. `*-jitter.png`
4. `*-panel.png`（三列拼图）
5. `*-off-on-diff.png`
6. `*-on-jitter-diff.png`
7. `*-report.json`（含 `alphaSum/nonZeroAlphaPixels` 与两组 diff 指标）

## 轻量交互实验（不走 replay）

如果 replay 链路太重，可以直接用可视化页面做快速 A/B：

文件：

`tests/visual/gpu-cpu-comparison.html`

新增模式：

`Texture Each Tip 实验 (off/on/jitter)`

使用步骤：

1. 打开该页面，模式切到 `Texture Each Tip 实验 (off/on/jitter)`。
2. 选择实验后端（建议先 `GPU`），设置 `mode/depth/jitter/scale/seed`。
3. 点击 `运行测试`，页面会输出三列：`Each Tip Off`、`Each Tip On`、`Each Tip On + Jitter`。
4. 查看结果区指标：`alphaSum / nonZero / meanAlpha`，重点看 `off→on ΔalphaSum` 是否显著为正（更深趋势）。

说明：

1. 该模式内置了测试纹理（内存注册），不依赖 ABR/replay 资源。
2. `Jitter` 场景会按 dab 调用 `computeTextureDepth(...)`，用于观察每 dab 深浅抖动趋势。
3. 这是趋势验证工具，不是像素级 Photoshop 对齐证明。

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
