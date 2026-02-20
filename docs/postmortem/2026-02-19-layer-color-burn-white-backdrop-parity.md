# Postmortem: Layer Color Burn 在纯白底色下的 PS 对齐差异（2026-02-19）

## 背景
用户反馈图层混合模式 `color-burn` 与 Photoshop 不一致。复现场景为：

1. 底层纯白背景（`#FFFFFF`）。
2. 中间层紫色块（用于观察局部重叠）。
3. 顶层纯黑块，混合模式设置为 `color-burn`。

在 Photoshop 中，黑块覆盖纯白底色区域会接近“不可见”；在 Sutu 中该区域表现为纯黑，视觉差异明显。

## 现象
1. `color-burn` + `src=black` + `dst=white` 时，Sutu 输出黑色。
2. 同一图中覆盖到非白底（如紫色）区域时，暗化趋势基本合理。
3. 该问题同时影响 CPU 路径与 GPU 路径（图层合成与渐变合成共享相同通道公式）。

## 根因分析
我们此前实现采用标准通道公式：

`burn(dst, src) = max(0, 1 - (1 - dst) / src)`，并在 `src<=eps` 时返回 `0`。

该公式对 `src=0` 的处理会直接输出 `0`（黑）。  
但 Photoshop 在 `color-burn` 上对“底色通道为纯白”存在兼容特判：`dst=1` 时通道保持 `1`，不进入普通 burn 计算。

因此在 `dst=white` 且 `src=black` 场景下，PS 结果保持白色，而我们旧实现落到黑色，导致“看得见黑块”。

## 修复方案
在所有 layer blend 共享实现中补齐同一规则：

1. `dst >= 0.9999` 时，`channel_color_burn` 直接返回 `1`。
2. 其余情况沿用既有逻辑（包含 `src <= 0.0001` 返回 `0`）。

涉及文件：

1. `src/utils/layerBlendMath.ts`
2. `src/gpu/shaders/tileLayerBlend.wgsl`
3. `src/gpu/shaders/tileGradientComposite.wgsl`

## 验证结果
1. 新增单测覆盖：
   - 纯黑 source + 纯白 backdrop -> 输出保持白色。
   - 近白通道边界（`254/255`）仅影响非纯白通道。
2. 相关回归测试通过：
   - `src/utils/__tests__/layerBlendMath.test.ts`
   - `src/utils/__tests__/gradientRenderer.test.ts`
   - `src/utils/__tests__/layerRenderer.transparentBackdropBlend.test.ts`
3. `pnpm -s typecheck` 通过。

## 经验沉淀
1. **Blend mode 不能只看标准公式，还要覆盖 DCC 实现特判。**  
   尤其是 Photoshop 对极值通道（0/1）的边界行为，常有历史兼容分支。
2. **CPU/WGSL 共享数学模型必须同步修改。**  
   任何单边修复都会导致 fallback 或工具链路（如 gradient）出现二次偏差。
3. **边界值要进入自动化回归。**  
   `src=0`、`dst=1`、`dst≈1` 这类点必须有单测，避免后续“公式清理”时被回退。

## 后续防回归
1. 为常用暗化/提亮模式补充一组“极值像素契约测试”（`0/1/254/255`）。
2. 在 blend mode 设计文档中补一页“PS 兼容边界行为清单”，减少重复踩坑。
