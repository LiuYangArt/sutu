# 2026-02-19 WinTab 丢笔复盘：DOM 活跃门控误抑制 Native Pump

## 结论

本轮 WinTab “后几笔偶发整笔丢失” 的主因不是后端没上报，而是前端消费门控错误：

1. WinTab V3 输入已经到达前端（`frontend.recv.native_v3` 存在）。
2. 但部分笔没有对应 DOM `pointerdown/move`。
3. 旧逻辑在“悬停移动”时也持续刷新 DOM 活跃时间，导致 native pump 长期不触发。
4. 结果是 native 样本未进入 `native_consume`/画布消费链，整笔丢失。

修复后，用户复测未再出现丢笔。

---

## 现象

用户反馈：

1. PointerEvent 一直正常。
2. WinTab 丢笔是“整笔消失”，并非单点抖动。
3. 丢笔前后可复现“前几笔正常、后几笔消失”。

---

## 证据（`tablet-input-trace.ndjson`）

按 `stroke_id` 聚合后观察到：

1. `stroke=2/3`：`recv.native_v3 > 0` 且 `native_consume > 0`，可绘制。
2. `stroke=4/5`：`recv.native_v3 > 0` 但 `native_consume = 0`，整笔未消费。
3. 丢失笔段附近没有 DOM `pointerdown/pointermove`，说明问题在“依赖 DOM 触发消费”这层，而非 Rust 上报缺失。

这直接定位为“前端门控导致不消费”，不是 WinTab 后端无数据。

---

## 根因

`usePointerHandlers` 中有一条“DOM 活跃时间”门控链：

1. native pump 只有在 `domInactiveForMs >= timeout` 时才执行。
2. 旧代码在每次 `pointermove` 一进入就刷新 DOM 活跃时间。
3. 即使只是悬停（未建立绘制会话）也会持续刷新，导致 `domInactiveForMs` 始终很小。
4. 当某笔缺少 DOM `pointerdown` 时，native pump 被误抑制，无法从 native `down` 启动笔画。

次级风险：

1. native pump 已经开笔后，晚到的同 pointer DOM `pointerdown` 可能重复触发开笔逻辑，导致收笔/重启干扰。

---

## 修复

文件：`src/components/Canvas/usePointerHandlers.ts`

1. DOM 活跃时间仅在“已建立 DOM 笔会话”时更新，不再被悬停 move 刷新。
2. 保留 native pump，但解除悬停 move 对其误抑制。
3. 增加保护：native 已开笔时，晚到的同 pointer DOM `pointerdown` 直接忽略（`frontend.pointerdown.duplicate_ignored`）。

文件：`src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`

1. 新增回归测试：native 已激活时，重复/晚到 DOM down 不应触发 `finishCurrentStroke` 或重复消费。

---

## 验证

自动化：

1. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
2. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.test.ts`
3. `pnpm -s typecheck`

用户实测：

1. 同场景连续多笔复测，当前未再出现 WinTab 丢笔。

---

## 可复用调试法（沉淀）

核心原则：按边界分层看证据，不凭体感猜测。

1. Rust 上报层：`frontend.recv.native_v3`
2. 前端消费层：`frontend.pointermove.native_consume` / `frontend.native_pump.consume`
3. 画布入队层：`frontend.canvas.consume_point` / `frontend.canvas.consume_tail_point`
4. 渲染输出层：`frontend.canvas.dab_emit`

判定模板：

1. `recv 有、consume 无`：输入已到前端但未进入消费链（门控/会话问题）。
2. `consume 有、dab_emit 长期为 0`：笔刷采样或渲染门禁问题。
3. `DOM 正常、native 缺失`：后端采样或 IPC 链路问题。

这套方法已整理为仓库 skill：`.codex/skills/wintab-trace-triage/SKILL.md`。
