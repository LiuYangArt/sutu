# 笔刷大小快捷键非线性改进

## 背景

笔刷大小 slider 使用非线性映射（midValue=100 在 50% 位置，后半段使用幂次曲线），但快捷键 `[` `]` 使用固定增量 ±5/±10，导致体验不一致。

## 方案

每按一次快捷键 = slider 移动固定 2.5%，复用已有的 `sliderScales.ts` 转换函数。

## 改动

### `sliderScales.ts`

- 新增 `stepBrushSizeBySliderProgress` 函数

### `useKeyboardShortcuts.ts`

- 替换硬编码增量为调用新函数
- 移除 Shift 加速逻辑

## 验证

- 单元测试：小笔刷步进增量小，大笔刷步进增量大
- 手动验证：按键从 1px 到 1000px 过程平滑
