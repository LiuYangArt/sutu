# Native 输入坐标回归重构方案（WinTab + MacNative）

**日期**：2026-02-18  
**状态**：待实施  
**范围**：`wintab`、`macnative` 输入坐标链路（不改 KritaPressurePipeline 主体）

---

## 1. 直接结论

当前问题是一次输入层回归，不是笔刷 pipeline 数学模型本身坏了。

1. `pointerevent` 正常，说明下游 `KritaPressurePipeline` 基本可用。  
2. `wintab` 乱飞、`macnative` 镜像，说明问题集中在“native 坐标进入前端主几何链路”的这段。  
3. 相比早期稳定状态，本分支把几何主坐标从 `PointerEvent clientX/clientY` 切到了 native 点映射，但缺少后端坐标语义契约与每后端校准，导致回归。

---

## 2. 已确认事实（代码证据）

1. `7e0e4c4 -> 6196127` 期间，`src-tauri/src/input/wintab_backend.rs` 未发生改动；回归主要发生在前端消费逻辑变更。  
2. `usePointerHandlers/useRawPointerInput` 现状会在 native 路径中将 `nativePoint.x/y` 映射后直接作为几何坐标。  
3. `wintab` 后端样本语义较弱：`pointer_id=0`、phase 主要由 pressure 推断，不是完整的 pointer 事件语义。  
4. `macnative` 使用 `NSEvent.locationInWindow()`，这是 AppKit 坐标；当前前端映射未做“后端坐标系契约化”，镜像/翻转无法被稳定识别。

---

## 3. 问题根因（第一性原理）

### 3.1 几何源切换回归

重构后把“几何真值”切到 native 坐标，但 native 坐标没有先被标准化到统一契约（DOM client/CSS px）。

结果：
1. WinTab：偶发异常点进入几何主链，dab 会沿异常段发射。  
2. MacNative：坐标系方向/原点差异未消解，表现为镜像或反向运动。

### 3.2 双源汇合缺少硬边界

虽然加入了 `per-stroke source lock`，但 native 源本身不稳定时，仍会把坏的 native 几何当作真值；锁只能防“混源”，不能防“坏源”。

### 3.3 缺少“坐标契约 + 会话契约”

当前契约只规范 pressure/tilt/time/source，缺少坐标语义字段（单位、原点、轴方向、宿主窗口空间）。  
没有契约，就只能靠前端启发式推断（scale/offset），在多后端下必然脆弱。

---

## 4. 重构目标（本轮必须达成）

1. `wintab`：无乱飞、无外射、收笔稳定。  
2. `macnative`：无左右镜像、无上下反向、轨迹与笔尖一致。  
3. 前端不再使用“猜测型 native 坐标映射”作为长期方案。  
4. 坐标在进入前端前已标准化为统一语义，前端只做消费，不做后端特定推断。

---

## 5. 重构方案（目标架构）

## 5.1 输入契约升级（新增坐标语义）

在 V2 输入样本契约中新增/冻结：

1. `coord_space`: `window_client_css_px`（本轮唯一合法值）  
2. `coord_origin`: `top_left`  
3. `axis_x`: `right_positive`  
4. `axis_y`: `down_positive`

说明：
1. 后端必须输出上述统一语义；前端不再做坐标系猜测。  
2. 若后端无法满足，样本标记 invalid 并丢弃，不进入几何主链。

## 5.2 后端标准化（Rust）

### WinTab

1. 在 Rust 侧完成坐标转换，输出到 `window_client_css_px`。  
2. 明确 down/move/up 会话边界，不再仅依赖 pressure>0 推断。  
3. 保留原始字段仅用于诊断，不再直接给前端做几何。

### MacNative

1. 将 `locationInWindow` 转为与 WebView DOM 一致的 top-left client 坐标。  
2. 在 Rust 侧完成必要的翻转处理（尤其是 y 轴）；禁止前端再做镜像猜测。  
3. 验证左/右、上/下方向一致性后再放量。

## 5.3 前端简化（TS）

1. 删除 `resolveNativePointMapping` 这类启发式几何映射主路径。  
2. native 模式下直接消费标准化后的 `x/y`。  
3. `getEffectiveInputData` 仅做 pressure/tilt/time/source 归一化，不再承担几何纠偏。  
4. `pointerevent` 继续作为独立稳定路径，不和 native 几何混合。

## 5.4 坏点防护（统一安全阈）

新增统一防护层（后端或前端入口）：

1. 单样本位移上限（按 dt 推导速度上限）。  
2. 非法 timestamp / 倒序样本丢弃。  
3. 异常突变点仅做“丢弃或截断”，不做几何补偿。

---

## 6. 实施阶段

## Phase 0：冻结回归基线（1 天）

- [ ] 固定复现录制：`wintab` 乱飞 + `macnative` 镜像 + `pointerevent` 正常。  
- [ ] 产出三组对照 trace（同动作、同画布、同缩放）。  
- [ ] 在文档记录“最后正常提交”与“首个异常提交”。

产出：
1. `artifacts/native-input-regression/*`  
2. 回归对照表（动作 -> 预期 -> 实际）

## Phase 1：Rust 坐标标准化（2-3 天）

- [ ] WinTab 输出统一 client 坐标语义。  
- [ ] MacNative 输出统一 client 坐标语义。  
- [ ] 契约字段升级并加单测（序列化 + 向后兼容）。

产出：
1. `src-tauri/src/input/*` 重构提交  
2. 契约测试与样本快照

## Phase 2：前端消费重构（1-2 天）

- [ ] 移除 native 几何启发式映射主路径。  
- [ ] `usePointerHandlers/useRawPointerInput` 改为直接消费标准坐标。  
- [ ] 保留最小兜底：仅在样本 invalid 时丢弃，不做坐标猜测。

产出：
1. `src/components/Canvas/usePointerHandlers.ts`  
2. `src/components/Canvas/useRawPointerInput.ts`

## Phase 3：回归测试与验收（1-2 天）

- [ ] 自动化回归：WinTab 外射、MacNative 镜像、PointerEvent 对照。  
- [ ] 手工回归：快弧线、左侧逆时针圈、收笔甩尾。  
- [ ] 通过后更新主计划状态与 postmortem。

产出：
1. 新增测试文件与结果 artifacts  
2. 文档更新（本计划 + 主计划）

---

## 7. 验收标准（必须同时满足）

1. WinTab：
1. 不出现“向外发射线”。
2. 收笔不外飞，末端位置连续。

2. MacNative：
1. 在画布左侧向左画圈，笔触仍在左侧，不出现左右镜像。
2. 上下方向与笔尖移动一致。

3. PointerEvent：
1. 结果与当前正常状态一致，不退化。

4. 自动化：
1. 新增回归测试全部通过。
2. `pnpm -s typecheck` 通过。

---

## 8. 风险与应对

1. 风险：后端坐标标准化涉及平台 API 细节，首轮可能仍有偏差。  
应对：先在 trace 可视化里验证方向与单位，再接入主绘制。

2. 风险：一次改动过大引入新回归。  
应对：按 Phase 切分，逐阶段可回退，且每阶段有独立验收。

3. 风险：MacNative/WinTab 行为差异长期存在。  
应对：契约层统一坐标语义，后端各自适配，前端不再分支推断。

---

## 9. Task List（执行清单）

- [ ] 建立 native 坐标契约字段并完成 Rust/TS 对齐。  
- [ ] WinTab 坐标输出改造为统一 client 语义。  
- [ ] MacNative 坐标输出改造为统一 client 语义。  
- [ ] 前端移除 native 几何启发式映射主路径。  
- [ ] 新增 WinTab 外射回归测试。  
- [ ] 新增 MacNative 镜像回归测试。  
- [ ] 新增 PointerEvent 不回归对照测试。  
- [ ] 更新 `docs/plans/2026-02-18-krita-pressure-full-rebuild-plan.md` 对应任务状态。  
- [ ] 产出 postmortem（记录“为何回归、如何避免再发”）。

---

## 10. Thought（关键判断依据）

1. 既然 `pointerevent` 正常，而 native 两后端异常，优先排除下游 pipeline。  
2. 回归窗口显示后端代码基本不变、前端几何消费策略变了，主因在消费链路而非设备驱动。  
3. 坐标问题不能靠前端启发式长期修补，必须把坐标语义前移到后端契约层。  
4. 先统一坐标语义，再谈手感对齐；否则任何 pressure/speed 调参都会被错误几何掩盖。

