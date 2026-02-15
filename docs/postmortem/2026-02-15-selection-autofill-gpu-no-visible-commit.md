# 选区自动填色“提交成功但画布不落色”复盘（2026-02-15）

**日期**：2026-02-15  
**状态**：已修复

## 背景

选区自动填色已切到 GPU 提交链路，并引入了“锁定预览”以消除空白帧。  
线上体验仍出现回归：lasso 结束后预览消失，但真实颜色没有落实到画布。

## 现象

1. 选区创建阶段预览正常。  
2. pointer up 后会触发自动填色提交流程。  
3. 控制台可看到提交流程进入，但最终画布不显示填色结果（或表现不稳定）。

## 根因

本次问题是两个独立问题叠加：

1. Shader 混合公式错误  
`tileSelectionFillComposite.wgsl` 中 source-over 的 RGB 计算误用了 `(1 - dst_alpha)`，导致目标像素 alpha 较高时，填色贡献被错误压低，表现为“提交了但几乎看不见变化”。

2. no-readback 与 CPU 合成路径一致性冲突  
选区自动填色提交在 `readbackMode=disabled` 下会延后同步 CPU 图层；但后续缩略图与部分合成流程依赖 CPU canvas，造成“GPU 已改、CPU 仍旧”的短时不一致，结果可能被旧画面覆盖或看不到。

## 修复

1. 修正 selection fill shader 的 source-over 公式。  
2. 选区自动填色提交后强制立即 readback 到 CPU 图层（仅该链路），确保历史/缩略图/合成读到一致像素。  
3. 提交前显式将本次 `selectionMask` 快照写入 `gpuRenderer`，避免 mask 时序偏差。  
4. 保留失败路径日志（layer 不可编辑、mask pending、无 committed tiles、提交异常）用于后续诊断。

## 验证

1. 自动化
- `tileSelectionFillCompositeShader.test.ts`
- `GpuCanvasRenderer.selectionFill.test.ts`
- `useLayerOperations.selectionAutoFill.test.ts`
- `SelectionOverlay.test.tsx`
- `pnpm -s typecheck`

2. 手测
- lasso 结束后不再出现“预览消失但未落色”。  
- 连续多次选区自动填色均可落实到画布。  
- 控制台不再需要保留成功日志，失败时仍可定位原因。

## 经验沉淀

1. GPU 写入链路只要后续有 CPU 读取（历史、缩略图、CPU 合成），必须定义“何时强一致”。  
2. source-over 这类基础合成公式需要有针对性测试断言，避免“视觉上像偶发”的数学回归。  
3. “提交成功”不等于“用户可见成功”；诊断必须覆盖“提交 -> 同步 -> 展示”整条链路。
