# 2026-02-20 WinTab 切换后偶发长时间无法绘制复盘：native seq 回绕与前端读游标失配

## 结论

本次“WinTab / PointerEvent 多次切换后偶发整笔画不出，等待较久又恢复”的根因是：

1. 切回 WinTab 后，native 输入流 `seq` 从小值重新开始。
2. 前端读游标 `read_cursor_seq` 仍停留在切换前的大值。
3. `readPointBufferSince(lastSeq)` 按“只读 `seq > lastSeq`”过滤，导致新流被整体判空（`native_empty` 连续增长）。
4. 只有当新流 `seq` 再次增长并超过旧游标后，才“看起来自己恢复”。

这解释了“不是每次都复现、但一旦中招要等很久才恢复”的体感。

---

## 现象

1. 先用 WinTab 可绘制。
2. 切到 PointerEvent 再切回 WinTab，短期可能正常。
3. 多切换几轮后，出现 pointerdown 有事件但整笔不出墨。
4. 不做任何操作等待较久后，又可能恢复。

---

## 证据

来自 `tablet-input-trace.ndjson` 的关键片段：

1. 切换后出现 `frontend.recv.native_v3`，说明后端确实在上报。
2. 同时可见 `seq` 从小值重启（例如 `1/17/24/...`）。
3. 前端消费侧日志出现 `read_cursor_seq` 仍为旧大值（例如 `286`）。
4. 同时 `frontend.pointermove.native_empty` / `frontend.native_pump.empty` 连续出现。
5. 未观察到 `frontend.pointerdown.blocked_*` 成为主因，排除常见“锁/图层/容器”拦截。

判定：问题位于“前端缓冲读取游标与新流序号空间不一致”，而非“后端无数据”。

---

## 根因

`pointBuffer` 与 `nativeSeqCursorRef` 的默认假设是“`seq` 单调递增且不会回绕”。  
该假设在 backend 切换后失效：

1. 新 backend 会话的 `seq` 重新从小值计数。
2. 旧游标仍保留切换前的大值。
3. 读取逻辑持续返回空，造成整笔无法启动或持续“缺样”。

---

## 修复

### 1) 缓冲写入侧增加回绕重置

文件：`src/stores/tablet.ts`

1. `addPointToBuffer` 在检测到“明显回绕”时重置 `pointBuffer`，并记录 `frontend.buffer.seq_rewind_reset`。
2. 判定条件采用阈值 + 启动特征（大幅回退且新点为 `down` 或低 seq）。

### 2) 缓冲读取侧增加游标 rebase

文件：`src/stores/tablet.ts`

1. `readPointBufferSince` 发现 `latest.seq < lastSeq` 时不再硬判空。
2. 直接返回当前缓冲尾部并把 `nextSeq` 对齐到新流，同时记录 `frontend.buffer.cursor_rewind_rebase`。

### 3) backend 切换成功后做会话硬清理

文件：`src/stores/tablet.ts`

1. `switchBackend` 成功后清理 `pointBuffer`。
2. 同步重置 `currentPoint / inProximity / nativeTraceStrokeActive`。
3. 打点 `frontend.backend.switch.success` 并携带 `point_buffer_cleared: true`。

### 4) 前端 pointer 会话补强（同轮修复）

文件：`src/components/Canvas/usePointerHandlers.ts`

1. 增加 backend 会话键，切换后遇到旧 pointer 会话可自动 reset（`frontend.pointerdown.backend_switch_session_reset`）。
2. duplicate pointerdown 增加“短窗口忽略 + 超窗强制重启”分流日志，减少粘滞态。

---

## 验证

自动化：

1. `pnpm -s vitest run src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
2. `pnpm -s vitest run src/components/Canvas/__tests__/usePointerHandlers.test.ts`
3. `pnpm -s typecheck`

手工：

1. 按“WinTab <-> PointerEvent 连续切换 + 连续落笔”回归。
2. 目前用户反馈“暂未再复现”。

---

## 经验沉淀

1. 输入链路的 `seq` 不能默认“跨 backend 会话全局单调”，读取游标必须具备回绕自愈能力。
2. “等很久又恢复”通常意味着存在阈值/游标错位，而不是随机抖动。
3. 追日志时要区分三层：
   1. `frontend.recv.native_v3`：后端是否到前端。
   2. `read_cursor_seq` vs `latest_buffer_seq`：是否游标失配。
   3. `frontend.pointerdown.blocked_*`：是否被前端门控直接拦截。
