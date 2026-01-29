# 2026-01-29 Postmortem: ABR Grayscale Pattern Decoding Failure

## 1. Issue Description / 问题描述

**Summary**: ABR brush patterns (specifically Grayscale patterns) display as "colorful noise" ("花屏") or horizontally stretched/streaky images in the application, despite robust backend decoding.

**Impact**: Users cannot see or use the correct brush textures. High-impact visual bug.

**Root Cause Class**: **Frontend/Backend Protocol Mismatch** (Format Mismatch).

## 2. Timeline / 时间线

- **Initial State**: Patterns showed "Texture: None".
- **Fix Attempt 1 & 2**: Fixed backend decoding (Universal Scanner + Raw Check) in `commands.rs`. Validated with debug script.
- **Production Failure**: User reported "Still messy".
- **Investigation**:
  - Backend `commands.rs` was confirmed to be converting decoded data into **RGBA** (4 bytes/pixel) and caching it.
  - Frontend `src/utils/brushLoader.ts` was examined.
  - **Discovery**: `loadBrushTexture` assumes the input data from `project://` protocol is **Gray8** (1 byte/pixel) LZ4 stream.
  - It manually expands the buffer: `rgba[i*4] = input[i]`.

## 3. Root Cause Analysis / 根因分析

**Confirmed Root Cause**: **Format Mismatch**.

1.  **Backend (`commands.rs`)**:
    - Decodes pattern data (Raw or RLE).
    - Converts it to **RGBA** (`Vec<u8>` where len = W _ H _ 4).
    - Caches this RGBA buffer using `cache_pattern_rgba`.

2.  **Frontend (`src/utils/brushLoader.ts`)**:
    - Fetches the cached data (LZ4 decompressed).
    - **Assumes input is Gray8** (1 byte per pixel).
    - Loops `for (let i = 0; i < input.length; i++)`.
    - Expands `input[i]` to `R,G,B` and sets `A=255`.
    - **The Bug**: Since `input` is actually RGBA (4x larger than Gray8), the frontend interprets:
      - Byte 0 (Red) -> Pixel 0 (Gray)
      - Byte 1 (Green) -> Pixel 1 (Gray)
      - Byte 2 (Blue) -> Pixel 2 (Gray)
      - Byte 3 (Alpha) -> Pixel 3 (White/255)
    - This results in a **4x Horizontal Stretch**.
    - And because the loop writes to `rgba[i*4]`, it overflows the buffer for 75% of the iterations (which JS ignores or fails silently), meaning we only see the first 1/4 of the bytes (the top 1/4 of the image) stretched to fill the whole view.

This explains both the "Streaks" (horizontal stretching) and the "Messy" look (interpreting color channels as separate pixels).

## 4. Action Plan / 修复计划

**Goal**: Support both **Brushes** (which are cached as Gray8) and **Patterns** (which are cached as RGBA) in the same loader.

1.  **Modify Frontend (`src/utils/brushLoader.ts`)**:
    - Construct `loadBrushTexture` to detect format based on data size.
    - **Check**: `if (input.length === width * height * 4)`
      - **Handing**: Treat as **RGBA**. Copy directly to `Uint8ClampedArray`.
    - **Check**: `if (input.length === width * height)`
      - **Handling**: Treat as **Gray8**. Use existing expansion logic.

This fix is robust as it relies on the deterministic relationship between image dimensions and buffer size.

## 5. Lessons Learned / 经验总结

- **Verify Protocol Contracts**: Backend and Frontend must agree on data formats (Gray8 vs RGBA).
- **Check Data Flow**: Debug scripts only verified the _Backend Output_ (PNG), but the _Frontend Consumption_ of that data was the failure point.
- **Trace the Pipeline**: Looking at `commands.rs` (Producer) and `brushLoader.ts` (Consumer) revealed the mismatch immediately.
