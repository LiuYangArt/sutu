# 2026-02-19 WinTab 跨笔串线复盘：PointerDown 种子被旧笔 Up 污染

## 结论

本次 WinTab “两笔之间出现连线” 的主因不是短时竞态，而是 **pointerdown 阶段的 native seed 归一化错误**：

1. 新一笔 pointerdown 时，前端会从 native buffer 读取 seed。
2. 旧逻辑会把“上一笔的 `up` 样本（旧 `stroke_id`）”也当成 seed。
3. 导致新笔起点被锚定到上一笔尾部，出现跨笔连线。

修复后，串线问题消失，WinTab 笔触形态明显改善。

---

## 现象

用户反馈：

1. PointerEvent 始终正常。
2. WinTab 在第二笔/第三笔开头会从上一笔尾部拉线。
3. 即使两笔间隔很长，仍会复现。

这直接否定了“仅是近时间窗口竞态”的假设。

---

## 证据（来自 `tablet-input-trace.ndjson`）

在 `pointerdown` 邻近序列中，观察到以下模式：

1. 第二笔 `pointerdown` 时，`frontend.pointerdown.native_seed` 首先读到 `seq=27, stroke_id=1, phase=up`（上一笔）。
2. 随后才出现 `seq=28, stroke_id=2, phase=down`（当前笔）。
3. 第三笔重复同样模式：先读到 `stroke_id=2` 的 `up`，再读到 `stroke_id=3` 的 `down`。

这说明新笔起笔种子被旧笔尾样本污染。

---

## 根因

旧逻辑在 pointerdown 取 seed 时存在两个缺陷：

1. `resolveNativeStrokePoints` 对“当前有效笔”的定义过宽，没有强制从当前 `stroke_id` 的显式 `down` 开始。
2. pointerdown 路径允许 `up` 进入 seed，且未先做严格 pointer_id + 当前 stroke 裁剪。

结果是旧笔尾点参与了新笔起点。

---

## 修复

### 1) 收紧 native seed 归一化

文件：`src/components/Canvas/inputUtils.ts`

`resolveNativeStrokePoints` 新规则：

1. 仅保留最新 `stroke_id`。
2. 必须先找到该笔的显式 `down`。
3. seed 仅允许 `down/move`，过滤 `up/hover`。
4. 未见 `down` 时返回空，等待后续 native 样本。

### 2) pointerdown 先按 pointer_id 裁剪再取 seed

文件：`src/components/Canvas/usePointerHandlers.ts`

pointerdown 读取 buffer 时：

1. 先过滤 `pointer_id`。
2. `currentPoint` 也按同一 `pointer_id` 验证。
3. 再调用 `resolveNativeStrokePoints`。

---

## 验证

自动化：

1. `pnpm -s typecheck`
2. `pnpm test -- src/components/Canvas/__tests__/inputUtils.test.ts`
3. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
4. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.test.ts`

新增回归测试点：

1. 仅保留最新 stroke 且从 `down` 开始取 seed。
2. 旧笔 `up` 不得作为新笔 `pointerdown` seed。

---

## 经验

1. WinTab 排查必须按 `stroke_id` 验证“起笔 seed 来源”，只看 `seq` 连续不足以发现跨笔污染。
2. “两笔间隔长仍串线”优先指向语义错误（seed selection），而不是时间窗口竞态。
3. PointerEvent 正常而 WinTab 异常时，应优先检查 native 归一化入口是否引入了跨笔样本。
