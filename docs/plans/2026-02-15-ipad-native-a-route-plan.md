# iPad 原生分支 A 路线计划（共享 Rust Core）

**日期**：2026-02-15  
**状态**：已确认采用 A 路线（同仓双端 + 共享核心）

## 1. 结论

采用以下路线：

1. 保留当前桌面主线（Tauri + React + WebGPU）持续迭代。
2. 新增 iPad 原生分支（Swift/ObjC + Metal + MTKView + Apple Pencil 原生输入）。
3. 把可复用资产沉到 Rust Core（ABR/PAT/PSD/ORA/笔刷参数模型与资源库），避免双端分叉。

不建议新开 repo，不建议 iPad 全量重写为孤岛项目。

## 2. 目标与非目标

### 2.1 目标

1. iPad 端获得明显优于当前 WebView 路径的跟手度和帧稳定性。
2. 桌面端功能持续交付，不因 iPad 路线停摆。
3. 已有格式兼容资产（ABR/PAT/PSD/ORA）在 iPad 路线中持续复用。
4. 后续新功能能以“共享核心 + 双端适配”的方式交付。

### 2.2 非目标

1. 不在第一阶段追求桌面与 iPad UI 交互完全一致。
2. 不把所有现有 TS 渲染逻辑原样迁移到 iPad。
3. 不在短期内把所有工具一次性搬到 iPad。

## 3. 现有 Rust 复用评估

结论：**可复用比例高**，但需要把 Tauri 壳层与 Core 能力拆开。

### 3.1 可直接复用（高）

1. ABR 解析：`src-tauri/src/abr/*`
2. PAT 解析：`src-tauri/src/pattern/pat.rs`
3. Pattern Library：`src-tauri/src/pattern/library.rs`
4. Brush Library：`src-tauri/src/brush/library.rs`
5. 文件格式读写核心：`src-tauri/src/file/psd/*`、`src-tauri/src/file/ora.rs`

这部分主要是数据解析、资源索引、序列化逻辑，平台无关性强。

### 3.2 需要改造后复用（中）

1. 命令层：`src-tauri/src/commands.rs`  
   说明：目前以 `#[tauri::command]` 暴露，需要改为“Core API + 桌面/iPad 各自桥接”。
2. 缓存与资源路径策略：`src-tauri/src/brush/cache.rs`、`src-tauri/src/brush/pattern_cache.rs`  
   说明：目录和协议分发方式需从 Tauri 语义抽象出来。
3. PSD/ORA 的输入载体  
   说明：当前写入路径对 `base64 PNG` 友好，iPad 原生更适合 `RGBA/tile bytes` 接口。

### 3.3 不复用（低）

1. 现有 Web 前端渲染主链路：`src/gpu/*`（WebGPU 实现）
2. PointerEvent 导向的输入链路：`src/components/Canvas/*` 中的事件处理
3. WinTab/MacNative/PointerEvent 的桌面后端策略

这部分需要 iPad 原生重做。

## 4. 目标架构（A 路线）

建议维持单仓库，分为三层：

1. **Core 层（Rust）**：格式、资源库、笔刷参数模型、共享算法。
2. **桌面适配层**：Tauri 命令 + Web 前端调用。
3. **iPad 适配层**：Swift/ObjC 桥接 + Metal 渲染 + Pencil 输入。

建议目录（渐进演进，不要求一次重排）：

1. `apps/desktop-tauri`（现有桌面应用）
2. `apps/ipad-native`（新 iPad 原生应用）
3. `crates/sutu-core-formats`（PSD/ORA）
4. `crates/sutu-core-assets`（ABR/PAT/Brush/Pattern library）
5. `crates/sutu-core-brush-model`（笔刷参数与中间数据模型）

## 5. 分阶段计划

### Phase 0：边界冻结（1 周）

1. 冻结共享数据契约：
   - `BrushPresetCore`
   - `PatternResourceCore`
   - `ProjectDataCore`
   - `DabParamsCore`
2. 定义输入输出协议：
   - 导入导出：文件路径 + 字节流双接口
   - 图像数据：优先 `RGBA/tile bytes`，保留 `base64` 兼容层
3. 输出一份跨端一致性判定口径（视觉与数据双标准）。

**验收**：桌面端与 iPad 端都能只依赖契约讨论，不再以实现细节对齐。

### Phase 1：抽取 Rust Core（2-3 周）

1. 从 `src-tauri` 中拆出平台无关 crate。
2. 桌面端先改为“调用新 core + 保留旧接口行为”。
3. 增加核心单测与回归样例：
   - ABR 导入一致性
   - PAT 导入一致性
   - PSD/ORA 往返稳定性

**验收**：桌面功能无回退，核心能力在无 Tauri 上下文下可测试可调用。

### Phase 2：iPad Native Spike（2-3 周）

1. Pencil 输入最小闭环：coalesced/predicted/palm rejection。
2. Metal 最小渲染闭环：单层画笔、基本混合、稳定帧循环。
3. 接入共享核心的 ABR/PAT 读取能力做真实素材验证。

**验收**：在目标 iPad 机型上完成连续绘制稳定性验证，并给出性能基线。

### Phase 3：功能并轨（4-6 周）

1. 接入 PSD/ORA 导入导出完整链路。
2. 接入 Pattern/Brush Library 同步策略。
3. 接入关键笔刷参数与纹理混合算法一致性验证。

**验收**：关键工作流（导入 ABR -> 绘制 -> 导出 PSD/ORA）跨端可用。

### Phase 4：持续演进（长期）

1. 新功能优先进入 Core，再做双端适配。
2. 建立跨端回放与差异报告机制，控制功能漂移。

## 6. 风险与应对

1. 风险：Core 抽取过程中桌面迭代变慢。  
   应对：分层迁移，优先保持 `commands` 对外行为不变。

2. 风险：iPad 渲染效果与桌面不一致。  
   应对：建立固定输入回放与关键参数快照对比。

3. 风险：历史数据接口（base64）拖慢 iPad 路径。  
   应对：新增原始像素接口，base64 只做兼容入口。

4. 风险：双端长期分叉。  
   应对：强制“新能力先 Core 后端上层”，并把一致性回归纳入门禁。

## 7. Git 与协作策略

1. 不 fork，不新 repo。
2. 在当前仓库创建长期分支：`feat/ipad-native-spike`。
3. Core 抽取以小 PR 逐步回主干，避免大规模一次合并。
4. iPad 分支按里程碑合并，不阻塞桌面常规功能迭代。

## 8. 当前优先任务（本周可执行）

1. 新增 `Core DTO` 草案文档与类型定义草稿。
2. 为 ABR/PAT/PSD/ORA 建立“最小共享 API”清单。
3. 确定 iPad Spike 验收指标（延迟、抖动、连续绘制稳定性）。
4. 建立第一个跨端一致性样例集（固定笔刷 + 固定输入回放 + 固定导出）。

## 9. 一句话回答：Rust 之前写的部分还能复用吗？

能，而且是本路线的核心前提。  
你的 ABR/PAT/PSD/ORA 与资源库管理逻辑大部分可复用；需要重写的是 iPad 的输入与渲染壳层，以及把部分 Tauri 绑定接口抽成平台无关 Core API。
