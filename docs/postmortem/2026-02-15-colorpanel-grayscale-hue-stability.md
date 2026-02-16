# ColorPanel 灰阶 hue 重置与滑块抖动复盘（2026-02-15）

**日期**：2026-02-15  
**状态**：已修复并补齐回归

## 背景

用户在 `ColorPanel` 中反馈两个连续问题：

1. 当前 hue 为非红色时，选择黑白灰后，色盘底色变成红色。  
2. 在色盘（S/V）选色时，hue 条滑块会偶发上下移动。

两个现象都指向同一段 HSVA 同步逻辑，属于状态回写链路不稳定。

## 现象

1. 灰阶颜色（`s=0`）下，`hexToHsva` 会给出 `h=0`。  
2. 组件将 `brushColor -> hexToHsva` 作为本地 hsva 的强同步来源。  
3. 当 `S/V` 拖拽触发 `HSVA -> HEX -> store -> HEX -> HSVA` 回写时，会出现 hue 被重算的抖动。

## 根因

本次问题由两个机制叠加造成：

1. **灰阶 hue 信息丢失**  
HEX 对灰阶不携带 hue 语义，直接反解会退化为 `h=0`。如果组件无条件采纳该值，UI 会回到红色基底。
2. **内部更新与外部回写未区分**  
color picker 内部更新也走全局 `brushColor` 回写，同一帧内二次反解可能受量化影响，导致 hue 滑块被动跳动。

## 修复

涉及文件：`src/components/ColorPanel/index.tsx`

1. 引入本地 `hsvaRef` 作为交互态真值，避免仅依赖 `brushColor` 反解。  
2. 在 `brushColor` 同步 effect 中，对灰阶颜色保留当前 hue，不再用 `hexToHsva` 的 `h=0` 覆盖。  
3. 增加 `pendingPickerHexRef` 标记内部触发的写色，命中后跳过一次反向同步，阻断“内部写入 -> 外部回写 -> 反解抖动”。

## 验证

1. 自动化
- `pnpm -s vitest run src/components/ColorPanel/ColorPanel.test.tsx`
- `pnpm -s typecheck`

2. 新增回归用例（`src/components/ColorPanel/ColorPanel.test.tsx`）
- `updates saturation square hue when brush color is grayscale and hue slider changes`
- `keeps previous hue when external color changes to grayscale`
- `does not move hue slider when saturation square updates color`

3. 测试用例文档
- `docs/testing/2026-02-15-colorpanel-hue-stability-test-cases.md`

## 经验沉淀

1. **灰阶与 hue 必须分层建模**：灰阶颜色不应强制覆盖当前 hue UI 状态。  
2. **区分内部交互更新与外部状态同步**：否则容易出现回写环导致的视觉抖动。  
3. **颜色控件要有专门回归集**：至少覆盖“灰阶切换、色盘拖拽、hue 拖拽”三类路径。  
4. **高频 UI 控件优先维护单向数据流**：写入与回读链路都要有明确边界和短路条件。
