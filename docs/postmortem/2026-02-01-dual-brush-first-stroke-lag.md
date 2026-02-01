# 2026-02-01 Dual Brush 首笔卡顿 Postmortem

## 1. Summary

Dual Brush 开启后第一笔存在明显卡顿（~120-180ms），后续笔画流畅。问题根因是 GPU 队列首次执行 Dual Brush 相关路径时发生驱动/资源预热，导致首笔阻塞。通过在 GPU 初始化阶段执行一次完整的 Dual Brush 预热笔画，将代价前置到启动阶段，消除首笔卡顿。

## 2. Issue

**现象**: 勾选 Dual Brush 后第一笔必现卡顿，后续无卡顿。

**范围**:
- 仅影响 Dual Brush 首次实际绘制。
- 与 Wet Edge / Scatter / 纹理等其他选项无强相关性（用户反馈）。

## 3. Root Cause

- 诊断日志显示 `queue.onSubmittedWorkDone()` 等待时间占绝对多数（> 120ms），`mapAsync` 本身仅数毫秒。
- Secondary dual mask 与 dual blend dispatch CPU 侧耗时极低，但 GPU 队列长时间阻塞，符合驱动首次调度/资源初始化成本。
- 首次触发发生在 Dual Brush 路径首次执行时（并非主笔刷路径）。

**结论**: 卡顿来源于 GPU 驱动/资源在 Dual Brush 路径的首次真实执行（含 dual mask compute + dual blend + presentable copy）的冷启动成本。

## 4. Solution

### 4.1 启动期预热 Dual Brush

在 GPU 初始化完成后，执行一次“完整 Dual Brush 预热笔画”，并等待 GPU 队列空闲，再开放 GPU 渲染：

- 预热 Dual Brush 纹理（若存在）。
- 走一遍真实的 Dual Brush 路径（secondary mask + dual blend + preview copy）。
- `await device.queue.onSubmittedWorkDone()` 确保冷启动成本已经消耗。

### 4.2 纹理提前上传

在 Dual Brush 纹理变化时提前触发 `writeTexture`，避免首笔才上传纹理。

## 5. Verification

- 复测：开启 Dual Brush 后第一笔无明显卡顿。
- 典型日志中 queue 阻塞消失，首笔耗时回落到常规范围。

## 6. Lessons Learned

1. GPU 首次运行路径的冷启动成本不可忽视，尤其是不同 pipeline / texture 组合首次执行时。
2. “首笔卡顿”应优先从 GPU 队列等待入手，而非 `mapAsync`。
3. 预热必须走“真实路径”，仅创建/dispatch 轻量 dummy 可能不足以触发驱动完整初始化。

## 7. Action Items

- [ ] 评估是否将“功能级预热”抽象为通用机制，避免类似问题重复出现。
- [ ] 未来新增 GPU 子路径时，默认提供一次冷启动预热策略。
