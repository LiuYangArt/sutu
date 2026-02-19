---
name: wintab-trace-triage
description: Use when WinTab or MacNative strokes are missing, linked, offset, or inconsistent versus PointerEvent and you need cross-layer evidence from native input to canvas output.
---

# WinTab Trace Triage

## Overview
Use trace evidence to locate the exact failure boundary before changing code. The goal is to answer one question fast: where did the stroke disappear, across backend emit, frontend consume, or canvas dab output?

## When to Use
- WinTab has dropped strokes while PointerEvent works.
- Strokes link across pen lifts, or offset changes with window/canvas movement.
- You need proof whether native packets arrived but were not consumed.
- You need a repeatable debug routine that another agent can run.

## Required Inputs
- Trace file: `C:\Users\<User>\AppData\Roaming\com.sutu\debug\tablet-input-trace.ndjson` (or custom path).
- Repro set with a known stroke count (for example: draw 4 strokes, note which ones fail).

## Procedure
1. Enable tracing:
```js
await window.__tabletInputTraceSet(true)
```
2. Reproduce with a small deterministic sequence (3-6 strokes).
3. Disable tracing:
```js
await window.__tabletInputTraceSet(false)
```
4. Run analyzer:
```bash
node scripts/debug/analyze-tablet-trace.mjs --file "C:\Users\LiuYang\AppData\Roaming\com.sutu\debug\tablet-input-trace.ndjson" --tail 12000
```
5. Inspect `stroke summary` and `suspicious strokes`.

## Interpretation
- `recv_native > 0 && native_consume = 0`:
  Native packets reached frontend but were not consumed (session gating / pump / pointer-state issue).
- `native_consume > 0` with many `input_without_dabs`:
  Points entered pipeline but brush sampling emitted no dabs (render/spacing/gate issue).
- Large `pointer_vs_native` delta in trace scopes:
  Coordinate mapping mismatch (window px -> canvas px path).
- Repeated `up` from previous stroke in new stroke seed:
  Cross-stroke seed contamination.

## Standard Evidence Scopes
- Native ingress: `frontend.recv.native_v3`
- DOM path: `frontend.pointerdown.dom`, `frontend.pointermove.dom`, `frontend.pointerup.dom`
- Native consume: `frontend.pointermove.native_consume`, `frontend.pointerup.native_consume`, `frontend.native_pump.consume`
- Canvas consume: `frontend.canvas.consume_point`, `frontend.canvas.consume_tail_point`
- Output: `frontend.canvas.dab_emit`
- Anomalies: `frontend.anomaly.native_missing_with_pointer`, `frontend.anomaly.input_without_dabs`, `frontend.canvas.queue_drop`

## Common Mistakes
- Reading only console snippets instead of the full ndjson file.
- Not tagging test action count (cannot map strokes to failures).
- Making fixes before proving which boundary fails.
- Mixing old and new traces in one file without tail filtering.
