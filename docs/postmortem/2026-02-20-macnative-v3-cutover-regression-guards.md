# MacNative V3 切主防回归清单（2026-02-20）

## 目标
将 WinTab V3 复盘中的高风险问题映射到 MacNative 主链，作为切主后长期守护项。

## 防线与门禁
1. 入口层分叉导致消费时钟漂移  
防线：`wintab/macnative/pointerevent` 全部收敛到同一 `UnifiedSessionRouterV3 + IngressGateStateV3`。  
门禁：`native_pump_primary_consume_rate = 0`、`host_to_ingress_consume_p95_ms <= 12`。

2. 空格平移误出笔  
防线：统一入口前置 `space/pan/zoom/move/canvas lock` 门禁，激活时禁止开新笔与继续喂点。  
门禁：`space_pan_draw_leak_count = 0`。

3. 跨笔 seed 污染  
防线：会话路由器按 `stroke_id` 消费，缺失 down 拒收 move/up。  
门禁：`native_down_without_seed_count = 0`。

4. backend 切换后 `seq` 回绕  
防线：`bufferEpoch` + 会话 cursor rebase + 回绕失败计数。  
门禁：`seq_rewind_recovery_fail_count = 0`。

5. 尾段丢失  
防线：`up` 必须显式进入尾段 mix；跨笔尾段直接拒收并计数。  
门禁：`stroke_tail_drop_count = 0`。

6. 坐标域漂移  
防线：Rust 统一 `client px` 语义，前端只缩放映射。  
门禁：`coord_out_of_view_count = 0`。

7. 主线程预算争用  
防线：事件驱动 drain（`nativeIngressTick`）+ RAF 兜底，避免 DOM 驱动成为主消费时钟。  
门禁：`emit_to_frontend_recv_p95_ms <= 8` 且 `native_empty_with_contact_rate <= 0.5%`。

8. 压力异常被掩盖  
防线：pressure clamp 计数 + 首点压力误差单独门禁。  
门禁：`pressure_clamp_rate <= 0.1%`、`first_dab_pressure_error_p95 <= 0.12`。

## 必跑验证
1. `cargo check --manifest-path src-tauri/Cargo.toml --lib`
2. `pnpm check:all`
3. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
4. `pnpm test -- src/components/Canvas/__tests__/useUnifiedInputIngress.test.ts`
5. `pnpm test -- src/engine/kritaParityInput/__tests__/unifiedSessionRouterV3.test.ts`
6. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativePipelineV3.test.ts`
7. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativeSeqRewindRecovery.test.ts`
