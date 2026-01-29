# Postmortem: ABR Texture Import Failure (Separated Structure)

**Date**: 2026-01-27
**Status**: Resolved (Diagnosis), Implementation in Progress
**File**: `docs/postmortem/2026-01-27-abr-structure-discovery.md`

## Symptom
Users reported that importing certain ABR files (e.g., `liuyang_paintbrushes.abr`) resulted in brushes loading correctly as shapes, but missing all texture information (Scale, Depth, Pattern). The brushes appeared as simple stamps without texture.

## Investigation
Initial debugging focused on the `parse_txtr_section` within the brush parsing loop.
1.  **Hypothesis 1**: The `Txtr` section parser was failing to match byte signatures for keys like `Scl` (Scale) or `Idnt` (UUID).
2.  **Test Result**: Instrumentation showed that for these brushes, the data block ended almost immediately after the image data. There was no `Txtr` section *inside* the brush block at all.
3.  **Hypothesis 2**: The data is missing or stored elsewhere.
4.  **Deep Scan**: A global scan of the ABR file structure revealed a "Separated Storage" architecture often used in larger/newer brush sets (likely Tool Presets saved as ABR).

### File Structure Analysis
The 23MB file contained:
-   **`samp` (Samples) Section** (4.8MB): Contains 71 brush tips (images only). This is what our parser was reading.
-   **`patt` (Patterns) Section** (19.0MB): A massive global section containing all the texture patterns used by the brushes.
-   **`desc` (Descriptor) Section** (150KB): A global Action Descriptor likely containing the mapping logic (binding Brush ID -> Pattern ID -> Settings).

## Root Cause
The current `AbrParser` implementation assumes a "Self-Contained" structure (common in older ABRs or simple exports) where `Txtr` settings are embedded directly within the `8BIM` sections of individual brushes inside the `samp` block.

It did not support the **Global Resource** structure where patterns and descriptors are stored as top-level siblings to the `samp` section.

## Solution Strategy
We are moving to a two-phase import strategy:

### Phase 1: Resource Extraction (Immediate)
1.  Update `AbrParser` to scan for global `patt` sections after reading brushes.
2.  Extract and parse these patterns using the new `PatParser`.
3.  Import these patterns into the `PatternLibrary` so they are available to the user.

### Phase 2: Linkage Reconstruction (Future)
1.  Parse the `desc` section to extract the `Brush -> Pattern` mapping and parameters (Scale, Mode, Depth).
2.  Apply these settings to the loaded `AbrBrush` instances before returning to the frontend.

## Implementation Update (2026-01-29)

Successfully implemented pattern extraction test script (`src-tauri/examples/extract_abr_patterns.rs`).

### Pattern Format Discovery

After hex dump analysis, the patt section pattern format was determined:

```
- 4 bytes: pattern total size (includes this field)
- 4 bytes: version (1)
- 4 bytes: color mode (1=Grayscale, 3=RGB, etc.)
- 2 bytes: width
- 2 bytes: height
- 4 bytes: name length (in UTF-16 characters, not bytes)
- N×2 bytes: name (UTF-16 BE encoding)
- Pascal string: ID/UUID (1-byte length + ASCII chars, 2-byte aligned)
- Padding to 4-byte boundary
- Image data (Raw or PackBits RLE compressed)
```

**Key findings:**
1. Pattern names use **UTF-16 BE** encoding (not ASCII/Pascal string as initially assumed)
2. Width/Height are 2-byte integers immediately after mode (not in bounds rect)
3. Each pattern has a 4-byte size prefix, followed by version and mode

### Test Results

Successfully extracted **10 patterns** from `liuyang_paintbrushes.abr`:

| Pattern Name | Dimensions | Mode |
|--------------|------------|------|
| Bubbles | 80x80 | RGB |
| Gravel | 200x200 | RGB |
| Black Marble | 200x200 | RGB |
| rough charlk | 200x200 | RGB |
| Sparse Basic Noise | 200x200 | Grayscale |
| Pattern 8 | 256x256 | RGB |
| sparthtex01 | 900x1200 | Grayscale |
| metal2 | 616x616 | Grayscale |
| SI080_L.jpg | 480x640 | RGB |
| 2 | 400x400 | RGB |

**Stats:** 3 Grayscale, 7 RGB patterns; Total 2.16 MPixels

### Implementation Notes

**Script location:** `src-tauri/examples/extract_abr_patterns.rs`

**Usage:**
```bash
cd src-tauri && cargo run --example extract_abr_patterns
```

The script implements:
- 8BIM section scanner to locate `patt` section
- Pattern parser with UTF-16 BE string decoding
- Bounds validation (width/height sanity checks)
- Progress reporting and summary statistics

## Lessons Learned

- **Don't assume locality**: In formats like PSD/ABR/TIFF, data is often referenced rather than embedded.
- **Global Scanning**: When local parsing fails, a global structure scan (dumping all top-level tags) is a powerful debugging tool.
- **Legacy vs. Modern**: ABR is a container format that has evolved from simple bitmaps (v1) to complex object hierarchies (v10). Support requires handling multiple internal architectures.
- **Text Encoding**: Photoshop formats often use UTF-16 BE for strings, not ASCII. Always verify encoding when parsing names.
- **Hex Dump Analysis**: When documentation is lacking, analyzing hex dumps of known-good files is essential for reverse engineering. Look for:
  - Recognizable ASCII/Unicode strings
  - Size fields (often 4-byte big-endian preceding data blocks)
  - Version numbers (commonly 1)
  - Coordinate values (small integers for dimensions)
