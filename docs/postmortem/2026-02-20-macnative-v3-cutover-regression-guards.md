# MacNative V3 切主防回归清单（2026-02-20）

## 目标
将 WinTab V3 复盘中的高风险问题映射到 MacNative 主链，作为切主后长期守护项。

## 防线与门禁
1. DOM 门控误抑制  
防线：hover move 不刷新 DOM 活跃时间，native pump 可独立开笔。  
门禁：`native_pump_suppressed_by_hover_count = 0`。

2. 跨笔 seed 污染  
防线：会话路由器按 `stroke_id` 消费，缺失 down 拒收 move/up。  
门禁：`native_down_without_seed_count = 0`。

3. backend 切换后 `seq` 回绕  
防线：`bufferEpoch` + 会话 cursor rebase + 回绕失败计数。  
门禁：`seq_rewind_recovery_fail_count = 0`。

4. 尾段丢失  
防线：`up` 必须显式进入尾段 mix；跨笔尾段直接拒收并计数。  
门禁：`stroke_tail_drop_count = 0`。

5. 坐标域漂移  
防线：Rust 统一 `client px` 语义，前端只缩放映射。  
门禁：`coord_out_of_view_count = 0`。

6. 主线程预算争用  
防线：cursor complexity budget + `forceDomCursorDebug` 强制旁路。  
门禁：`emit_to_frontend_recv_p95_ms <= 8` 且 `native_empty_with_contact_rate <= 0.5%`。

7. 压力异常被掩盖  
防线：pressure clamp 计数 + 首点压力误差单独门禁。  
门禁：`pressure_clamp_rate <= 0.1%`、`first_dab_pressure_error_p95 <= 0.12`。

## 必跑验证
1. `cargo check --manifest-path src-tauri/Cargo.toml --lib`
2. `pnpm check:all`
3. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
4. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativePipelineV3.test.ts`
5. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativeSeqRewindRecovery.test.ts`
