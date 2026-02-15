# ColorPanel Hue Stability 测试用例（2026-02-15）

## 1. 目标与范围

本用例用于防止 `ColorPanel` 在灰阶与低饱和度交互下出现以下回归：

1. 选择黑白灰后，色盘底色被重置为红色（`hue=0`）。  
2. 在色盘（S/V）拖拽时，右侧 hue 滑块被动上下跳动。  
3. 灰阶场景下拖动 hue 条时，色盘 hue 不刷新。

## 2. 自动化用例（Vitest）

文件：`src/components/ColorPanel/ColorPanel.test.tsx`

1. `updates saturation square hue when brush color is grayscale and hue slider changes`  
效果/用途：锁定“灰阶 + 改 hue 时，色盘 hue 仍应更新”，防止 hue 条对灰阶无效。
2. `keeps previous hue when external color changes to grayscale`  
效果/用途：锁定“外部把前景色改成灰阶时，不应把 hue 强制重置为 0（红色）”。
3. `does not move hue slider when saturation square updates color`  
效果/用途：锁定“在色盘改 S/V 时，hue 滑块位置应保持不变”。

执行命令：

```bash
pnpm -s vitest run src/components/ColorPanel/ColorPanel.test.tsx
pnpm -s typecheck
```

## 3. 手工回归步骤

### Case A：灰阶后 hue 不重置红色

1. 打开 `ColorPanel`，先把 hue 滑块拖到绿色附近（约 120 度）。  
2. 点击左侧黑/灰/白任一色块，或将前景色改为 `#808080`。  
3. 观察色盘底色和 hue 滑块位置。

预期结果：

1. 色盘底色保持为之前 hue（例如绿色系），不是红色。  
2. hue 滑块保持原位置，不跳回顶部。

### Case B：色盘拖拽不推动 hue 滑块

1. 将 hue 滑块放到任意非红色位置（例如 240 度蓝色）。  
2. 在色盘内按住拖拽，持续改变亮度和饱和度。  
3. 观察 hue 滑块是否移动。

预期结果：

1. hue 滑块位置不发生变化。  
2. 仅色盘内选点移动，前景色按当前 hue 的 S/V 变化。

### Case C：灰阶下 hue 条可刷新色盘

1. 将前景色设置为灰阶（如 `#808080`）。  
2. 在 hue 条上上下拖动。  
3. 观察色盘底色是否随 hue 改变。

预期结果：

1. 色盘底色随 hue 连续变化。  
2. 前景色在饱和度为 0 时可保持灰阶，但 hue 状态被正确记住。

## 4. 通过标准

1. 自动化用例全部通过。  
2. 三个手工 Case 结果均符合预期。  
3. 不出现 `Maximum update depth exceeded` 或明显 UI 抖动。
