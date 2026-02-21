## Summary

## Validation

- [ ] `pnpm check:all`
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml --lib`

## Input Ingress Guard (Required for input-related PRs)

- [ ] All input sources (`wintab/macnative/pointerevent`) flow through `UnifiedSessionRouterV3 + IngressGateStateV3`
- [ ] No bypass writes to drawing main queue outside whitelist modules
- [ ] `native_pump` remains debug fallback only (not default primary consume path)
- [ ] `bufferEpoch + seq rewind` recovery behavior remains covered

## Required Regression Tests (input-related PRs)

- [ ] `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
- [ ] `pnpm test -- src/components/Canvas/__tests__/useUnifiedInputIngress.test.ts`
- [ ] `pnpm test -- src/engine/kritaParityInput/__tests__/unifiedSessionRouterV3.test.ts`
- [ ] `pnpm test -- src/engine/kritaParityInput/__tests__/macnativePipelineV3.test.ts`
- [ ] `pnpm test -- src/engine/kritaParityInput/__tests__/macnativeSeqRewindRecovery.test.ts`

## Blocking Metrics (if trace attached)

- [ ] `native_pump_primary_consume_rate = 0`
- [ ] `space_pan_draw_leak_count = 0`
- [ ] `host_to_ingress_consume_p95_ms <= 12`
