# Color Dynamic Dab Ordering Bug

**Date**: 2026-01-21
**Component**: GPU Compute Shader (`computeBrush.wgsl`)
**Severity**: Medium - Visual artifact affecting Color Dynamic brush

## Symptom

When using Color Dynamic brush (which varies opacity per dab), later dabs appeared **under** earlier dabs instead of on top. The effect was:
- Long strokes showed incorrect layering
- Lower opacity dabs seemed to "disappear" behind higher opacity ones
- CPU rendering was correct; only GPU had the issue

## Root Cause

The `alpha_darken_blend()` function in `computeBrush.wgsl` had a flawed early-exit condition:

```wgsl
// BUGGY CODE
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  if (dst.a >= ceiling - 0.001) {  // <-- THE BUG
    return dst;  // Skips the entire dab!
  }
  // ...
}
```

**Problem mechanism:**

| Step | dab opacity (ceiling) | dst.a | Check | Result |
|------|----------------------|-------|-------|--------|
| 1 | 0.5 | 0.0 | 0.0 < 0.5 ✓ | Draw, dst.a → 0.5 |
| 2 | 0.3 | 0.5 | 0.5 >= 0.3 ✗ | **SKIPPED!** |
| 3 | 0.2 | 0.5 | 0.5 >= 0.2 ✗ | **SKIPPED!** |

Color Dynamic generates varying opacity per dab. When a later dab had lower opacity than the accumulated alpha, it was completely skipped - not just its alpha contribution, but its **color** too.

## The Fix

Each dab's `ceiling` should only limit **its own** alpha contribution, not determine whether to skip entirely. Later dabs must always blend their color on top:

```wgsl
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  let effective_ceiling = max(dst.a, ceiling);
  let alpha_headroom = effective_ceiling - dst.a;

  if (alpha_headroom <= 0.001) {
    // No alpha contribution, but STILL blend color on top
    if (src_alpha > 0.001 && dst.a > 0.001) {
      let blend_factor = src_alpha * ceiling;
      let new_rgb = dst.rgb + (src_color - dst.rgb) * blend_factor;
      return vec4<f32>(new_rgb, dst.a);  // Color changes, alpha stays
    }
    return dst;
  }

  let new_alpha = dst.a + alpha_headroom * src_alpha;
  // ... rest of blend logic
}
```

**Key insight:** `ceiling` is per-dab, not global. A dab with ceiling=0.3 on a pixel with dst.a=0.5 can't increase alpha, but it CAN and SHOULD paint its color on top.

## Files Changed

- `src/gpu/shaders/computeBrush.wgsl` - Fixed `alpha_darken_blend()` function

## Lessons Learned

1. **Alpha Darken semantics**: The "ceiling" parameter is a per-dab constraint, not a global accumulator limit
2. **Color vs Alpha are independent**: Even when alpha can't increase, color blending should still occur for correct layering
3. **GPU vs CPU divergence**: When GPU and CPU behave differently, trace the exact blend logic step by step
4. **Test with dynamic brushes**: Static opacity brushes won't reveal this bug - need varying opacity to trigger

## Verification

1. Enable Color Dynamic on any brush
2. Draw a long stroke with varying pressure
3. Confirm later portions of stroke appear ON TOP of earlier portions
4. Compare GPU and CPU rendering - should match
