# M5 Difference 与 Photoshop 不一致（延期处理）

**日期**：2026-02-07  
**状态**：已确认，延期（不阻塞 M5 收尾）

## 背景

M5 主线目标是：

1. 全选区 GPU 裁剪链路稳定可用。  
2. 导出统一走 GPU 分块 readback。  
3. 16 混合模式在 GPU/导出路径可用。

在收尾手测中，发现 `difference` 与 Photoshop 的视觉结果仍存在差异。

## 现象

1. 对比基准：`abr/Untitled.psd`。  
2. 左侧 Photoshop 与右侧 PaintBoard 对照时，`difference` 在颜色重叠区明显不一致。  
3. 当前观察到：`cpu` 与 `gpu` 两条路径在 `difference` 上也不完全一致。  
4. `luminosity` 在当前样例中更接近 Photoshop，但未完成全模式逐一验收。

## 已确认不再阻塞 M5 的项

1. 选区切换时“瞬间变色”问题已消失。  
2. PSD 导入后画布初始空白（需逐层开关才显示）已修复。  
3. PSD 导出图层顺序异常已修复。  

上述项已恢复可用，当前仅保留 `difference` 与 Photoshop 一致性差异。

## 初步判断

`difference` 偏差更可能是“混合公式与颜色空间/预乘语义的组合问题”，而不是 M5 的选区 GPU 或导出分块 readback 机制本身。

## 延期决策

1. 本问题纳入后续“PS 混合模式一致性专项”，不阻塞 M5 合并与发布节奏。  
2. M5 收尾阶段先保证功能闭环、稳定性与导出可用性。  

## 后续处理计划（专项）

1. 建立 `difference` 的 CPU/GPU/PS 三方对照基线（固定输入色块矩阵 + opacity 组合）。  
2. 明确并统一：
   - blend 计算使用的颜色空间（linear/sRGB）；
   - 是否采用预乘 alpha 参与公式；
   - layer opacity 与 blend 公式的先后顺序。  
3. 将 CPU 与 GPU 路径收敛到同一份可测试公式定义，避免双实现漂移。  
4. 以样例 PSD + 自动化像素统计作为验收门禁。

## 参考资料

1. https://www.deepskycolors.com/tools-tutorials/formulas-for-photoshop-blending-modes/  
2. https://zhuanlan.zhihu.com/p/521651485
