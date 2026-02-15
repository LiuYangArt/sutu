# iPad Apple Pencil 提示“macnative 无效并 fallback PointerEvent”复盘（2026-02-15）

**日期**：2026-02-15  
**状态**：已记录，未修复（先沉淀经验，后续专项处理）

## 背景

首次在 iPad 真机跑通后，用户反馈：

1. 应用提示“压感笔 macnative 输入无效，fallback 到 pointerevent”。  
2. Apple Pencil 可触发输入，但对“是否已正确走 Apple Pencil 压感链路”缺乏确定性。  
3. 首次联调还叠加过本地网络权限/VPN 问题，容易与输入后端问题混淆。

## 现象

1. iPad 端出现 backend fallback 提示（含 `macnative`、`pointerevent` 关键词）。  
2. 用户认知上会把它理解为“Apple Pencil 压感没接上/不可用”。  
3. 在同一轮调试中，本地网络权限未开或 VPN 开启会导致 dev server 连接失败，进一步放大排查噪音。

## 根因分析

本次不是单点代码崩溃，而是“平台策略 + 文案体验”的组合问题：

1. iOS 平台当前策略会强制规范化到 `PointerEvent`  
`src-tauri/src/commands.rs` 中，`normalize_requested_backend_for_platform()` 在非 Windows/macOS 平台分支固定返回 `BackendType::PointerEvent`。  
这意味着 iPad 上即使请求 `macnative`，也会被改写为 `pointerevent`。

2. fallback 信息对 iPad 用户不够友好  
当前 toast 文案是通用的 backend fallback 描述（`src/App.tsx`），会让用户误以为“压感一定失效”，但在 iPad 上通过 `PointerEvent` 仍可能拿到 Apple Pencil `pressure/tilt` 数据。

3. 联调阶段网络问题会伪装成输入问题  
若 iPad 未授予本地网络权限或 VPN 干扰，应用先因 `devUrl` 不可达失败；该问题与输入后端无关，但用户侧体感容易合并成“iPad 支持有问题”。

## 当前结论（阶段性）

1. “iPad 上出现 `macnative -> pointerevent`”在现有实现下是可预期行为。  
2. 该提示不等价于“Apple Pencil 压感不可用”。  
3. 目前缺少 iPad 端的压感可视化/验收闭环，导致无法快速回答“可用但质量如何”。

## 本次不做修复，仅记录的原因

1. 当前主目标是先打通 iPad 真机运行链路。  
2. 需要先沉淀输入后端事实与排查路径，避免后续重复踩坑。  
3. Apple Pencil 体验优化应单独成专题，不在本次上线联调内打包处理。

## 后续行动（待办）

1. 明确 iOS 支持说明：在 UI 与文档中区分“macOS 的 MacNative”与“iOS 的 PointerEvent(Apple Pencil)”。  
2. 优化 fallback 文案：将“平台不支持导致的规范化”与“初始化失败导致的降级”分开提示。  
3. 增加 iPad 压感诊断面板：实时显示 `pressure / tilt / pointerType / backend`。  
4. 增加 iPad 手测清单：压感连续性、倾斜、快速连笔延迟、Palm Rejection。  
5. 将“本地网络权限 + VPN 状态”加入 iOS 联调前置检查。

## 经验沉淀

1. 移动端输入问题必须先区分“后端选择策略”与“真实传感数据质量”。  
2. 平台规范化是合理策略，但提示文案若不分场景，会造成高成本误判。  
3. iPad 联调中，网络可达性和输入正确性是两条独立链路，必须分别验收。
