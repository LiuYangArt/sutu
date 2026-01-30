//! PSD file reader using the `psd` crate
//!
//! Converts PSD files to PaintBoard's ProjectData format.
//! Optimized with WebP encoding and parallel processing via Rayon.

use crate::benchmark::{generate_session_id, BackendBenchmark};
use crate::file::layer_cache::{cache_layer_rgba, clear_cache};
use crate::file::types::{FileError, LayerData, ProjectData};
use image::RgbaImage;
use psd::Psd;
use rayon::prelude::*;
use std::path::Path;
use std::time::Instant;

/// Load a PSD file and convert to ProjectData
///
/// Uses parallel processing (Rayon) and WebP encoding for optimal performance.
/// Layer images are cached via `project://` protocol instead of Base64 IPC.
///
/// Key optimizations:
/// - Parallel RGBA decode + WebP encode (merged Phase 3+4)
/// - Only encode layer bounds, not full canvas (avoids 10x+ overhead)
/// - Uses layer offset_x/y for positioning instead of full canvas composite
pub fn load_psd(path: &Path) -> Result<ProjectData, FileError> {
    let total_start = Instant::now();
    let session_id = generate_session_id();
    let file_path = path.to_string_lossy().to_string();
    tracing::info!("[PSD] Loading file: {:?}", path);

    // Clear previous cache before loading new project
    clear_cache();

    // Phase 1: File read
    let t1 = Instant::now();
    let data = std::fs::read(path)?;
    let file_read_ms = t1.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        "[PSD] Phase 1 - File read: {:.1}ms ({} bytes)",
        file_read_ms,
        data.len()
    );

    // Phase 2: PSD structure parse
    let t2 = Instant::now();
    let psd = Psd::from_bytes(&data)
        .map_err(|e| FileError::InvalidFormat(format!("PSD parse error: {}", e)))?;
    let format_parse_ms = t2.elapsed().as_secs_f64() * 1000.0;
    tracing::info!("[PSD] Phase 2 - PSD parse: {:.1}ms", format_parse_ms);

    let width = psd.width();
    let height = psd.height();
    tracing::debug!("[PSD] Dimensions: {}x{}", width, height);

    // Phase 3+4 MERGED: Parallel RGBA decode + WebP encode
    // This is the key optimization - we do both in parallel instead of serial decode + parallel encode
    let t3 = Instant::now();
    let psd_layers: Vec<_> = psd.layers().iter().collect();

    let layer_results: Vec<Result<LayerData, FileError>> = psd_layers
        .par_iter()
        .enumerate()
        .map(|(idx, psd_layer)| process_layer_parallel(psd_layer, idx, width, height))
        .collect();

    let decode_cache_ms = t3.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        "[PSD] Phase 3+4 - Parallel decode+cache: {:.1}ms ({} layers)",
        decode_cache_ms,
        layer_results.len()
    );

    // Collect successful results
    let mut layers = Vec::new();
    for result in layer_results {
        match result {
            Ok(layer) => {
                layers.push(layer);
            }
            Err(e) => {
                tracing::warn!("Failed to convert layer: {}", e);
            }
        }
    }

    // If no layers were converted, create a background from composite
    if layers.is_empty() {
        tracing::info!("No layers found, using composite image as background");
        let composite = psd.rgba();
        let layer = create_background_layer_cached(&composite, width, height)?;
        layers.push(layer);
    }

    // Reverse layers to match PaintBoard's bottom-to-top order
    // PSD stores layers top-to-bottom
    layers.reverse();

    let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        "[PSD] Total load time: {:.1}ms ({} layers)",
        total_ms,
        layers.len()
    );

    // Build benchmark data
    let benchmark = BackendBenchmark {
        session_id,
        file_path,
        format: "psd".to_string(),
        file_read_ms,
        format_parse_ms,
        decode_cache_ms,
        total_ms,
        layer_count: layers.len(),
        send_timestamp: None,
    };

    Ok(ProjectData {
        width,
        height,
        dpi: 72, // PSD doesn't expose DPI easily through psd crate
        layers,
        flattened_image: None,
        thumbnail: None,
        benchmark: Some(benchmark),
    })
}

/// Process a single PSD layer in parallel: decode RGBA + encode WebP + cache
///
/// Key optimization: Only encodes the layer's actual bounds, not full canvas.
/// This can reduce encoding data by 10-100x for small layers.
fn process_layer_parallel(
    psd_layer: &psd::PsdLayer,
    idx: usize,
    doc_width: u32,
    doc_height: u32,
) -> Result<LayerData, FileError> {
    let layer_id = format!("psd_layer_{}", idx);
    let name = psd_layer.name().to_string();

    // Decode RGBA (this is the expensive RLE decode operation)
    let rgba_data = psd_layer.rgba();

    // Get layer bounds
    let layer_left = psd_layer.layer_left();
    let layer_top = psd_layer.layer_top();
    let layer_right = psd_layer.layer_right();
    let layer_bottom = psd_layer.layer_bottom();
    let layer_width = (layer_right - layer_left).max(0) as u32;
    let layer_height = (layer_bottom - layer_top).max(0) as u32;

    // Build layer image - prefer layer bounds over full canvas
    let (layer_image, offset_x, offset_y) = build_layer_image(
        &rgba_data,
        &name,
        layer_left,
        layer_top,
        layer_width,
        layer_height,
        doc_width,
        doc_height,
    )?;

    // EXPERIMENT: Skip WebP encoding, cache raw RGBA directly
    // This eliminates the ~400ms/layer encoding overhead
    let img_width = layer_image.width();
    let img_height = layer_image.height();
    let image_bytes = layer_image.into_raw();

    tracing::debug!(
        "[PSD] Layer '{}': {}x{} at ({},{}) -> {} bytes (raw RGBA)",
        name,
        img_width,
        img_height,
        offset_x,
        offset_y,
        image_bytes.len()
    );

    // Cache raw RGBA data for project:// protocol
    cache_layer_rgba(layer_id.clone(), image_bytes, img_width, img_height);

    // Get blend mode
    let blend_mode = psd_blend_mode_to_string(&format!("{:?}", psd_layer.blend_mode()));

    Ok(LayerData {
        id: layer_id,
        name,
        layer_type: "raster".to_string(),
        // WORKAROUND: psd crate has inverted visible flag logic
        // PSD spec: bit 1 = 1 means HIDDEN, but psd crate interprets it as VISIBLE
        visible: !psd_layer.visible(),
        locked: false,
        opacity: psd_layer.opacity() as f32 / 255.0,
        blend_mode,
        is_background: Some(idx == 0),
        image_data: None, // Key: use project:// protocol instead of Base64
        offset_x,
        offset_y,
    })
}

/// Build layer image from RGBA data, preferring layer bounds over full canvas
///
/// Returns: (image, offset_x, offset_y)
///
/// This is the key optimization: instead of expanding to full canvas and encoding
/// a huge image with mostly transparent pixels, we only encode the actual layer content.
#[allow(clippy::too_many_arguments)]
fn build_layer_image(
    rgba_data: &[u8],
    name: &str,
    layer_left: i32,
    layer_top: i32,
    layer_width: u32,
    layer_height: u32,
    doc_width: u32,
    doc_height: u32,
) -> Result<(RgbaImage, i32, i32), FileError> {
    let full_canvas_size = (doc_width * doc_height * 4) as usize;
    let layer_size = (layer_width * layer_height * 4) as usize;

    // Case 1: Data matches layer bounds - use directly with offset (OPTIMAL)
    if rgba_data.len() == layer_size && layer_width > 0 && layer_height > 0 {
        let img = RgbaImage::from_raw(layer_width, layer_height, rgba_data.to_vec())
            .ok_or_else(|| FileError::InvalidFormat("Invalid layer RGBA data".into()))?;
        return Ok((img, layer_left, layer_top));
    }

    // Case 2: Data is full canvas size - use directly, offset = (0,0)
    if rgba_data.len() == full_canvas_size {
        let img = RgbaImage::from_raw(doc_width, doc_height, rgba_data.to_vec())
            .ok_or_else(|| FileError::InvalidFormat("Invalid full canvas RGBA data".into()))?;
        return Ok((img, 0, 0));
    }

    // Case 3: Data size mismatch - try to use layer bounds anyway
    tracing::warn!(
        "[PSD] Layer '{}': RGBA size {} doesn't match expected layer {} or canvas {}",
        name,
        rgba_data.len(),
        layer_size,
        full_canvas_size
    );

    // Try to create from layer bounds if we have enough data
    if rgba_data.len() >= layer_size && layer_width > 0 && layer_height > 0 {
        let truncated = rgba_data[..layer_size].to_vec();
        if let Some(img) = RgbaImage::from_raw(layer_width, layer_height, truncated) {
            return Ok((img, layer_left, layer_top));
        }
    }

    // Fallback: create 1x1 transparent image
    tracing::error!(
        "[PSD] Layer '{}': Cannot parse RGBA data, creating empty layer",
        name
    );
    Ok((RgbaImage::new(1, 1), 0, 0))
}

/// Encode RGBA image to WebP lossless, with PNG fallback
#[allow(dead_code)]
fn encode_layer_image(img: &RgbaImage, layer_id: &str) -> (Vec<u8>, &'static str) {
    // Try WebP first (faster encoding)
    match encode_rgba_to_webp_lossless(img) {
        Ok(data) => (data, "image/webp"),
        Err(e) => {
            // Fallback to PNG
            tracing::warn!(
                "WebP encoding failed for {}, falling back to PNG: {}",
                layer_id,
                e
            );
            match encode_rgba_to_png(img) {
                Ok(data) => (data, "image/png"),
                Err(_) => {
                    // Last resort: empty image
                    tracing::error!("PNG encoding also failed for {}", layer_id);
                    (Vec::new(), "image/png")
                }
            }
        }
    }
}

/// Encode RGBA image to WebP lossless format
#[allow(dead_code)]
fn encode_rgba_to_webp_lossless(img: &RgbaImage) -> Result<Vec<u8>, FileError> {
    use webp::Encoder;

    let encoder = Encoder::from_rgba(img.as_raw(), img.width(), img.height());
    let webp = encoder.encode_lossless();
    Ok(webp.to_vec())
}

/// Encode RGBA image to PNG format (fallback)
#[allow(dead_code)]
fn encode_rgba_to_png(img: &RgbaImage) -> Result<Vec<u8>, FileError> {
    use image::ImageFormat;
    use std::io::Cursor;

    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)?;
    Ok(buf.into_inner())
}

/// Create a background layer from composite image data (cached version)
fn create_background_layer_cached(
    rgba_data: &[u8],
    width: u32,
    height: u32,
) -> Result<LayerData, FileError> {
    let layer_id = "psd_background".to_string();

    // Cache raw RGBA data directly (no encoding)
    cache_layer_rgba(layer_id.clone(), rgba_data.to_vec(), width, height);

    Ok(LayerData {
        id: layer_id,
        name: "Background".to_string(),
        layer_type: "raster".to_string(),
        visible: true,
        locked: false,
        opacity: 1.0,
        blend_mode: "normal".to_string(),
        is_background: Some(true),
        image_data: None, // Use project:// protocol
        offset_x: 0,
        offset_y: 0,
    })
}

/// Convert PSD blend mode Debug string to PaintBoard blend mode string
fn psd_blend_mode_to_string(mode_debug: &str) -> String {
    match mode_debug {
        "Normal" => "normal",
        "Dissolve" => "dissolve",
        "Darken" => "darken",
        "Multiply" => "multiply",
        "ColorBurn" => "color-burn",
        "LinearBurn" => "linear-burn",
        "DarkerColor" => "darker-color",
        "Lighten" => "lighten",
        "Screen" => "screen",
        "ColorDodge" => "color-dodge",
        "LinearDodge" => "linear-dodge",
        "LighterColor" => "lighter-color",
        "Overlay" => "overlay",
        "SoftLight" => "soft-light",
        "HardLight" => "hard-light",
        "VividLight" => "vivid-light",
        "LinearLight" => "linear-light",
        "PinLight" => "pin-light",
        "HardMix" => "hard-mix",
        "Difference" => "difference",
        "Exclusion" => "exclusion",
        "Subtract" => "subtract",
        "Divide" => "divide",
        "Hue" => "hue",
        "Saturation" => "saturation",
        "Color" => "color",
        "Luminosity" => "luminosity",
        "PassThrough" => "normal",
        _ => "normal",
    }
    .to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_create_background_layer_cached() {
        // Initialize cache first
        crate::file::layer_cache::init_cache();

        let rgba = vec![255u8; 4 * 10 * 10]; // 10x10 white image
        let layer = create_background_layer_cached(&rgba, 10, 10).unwrap();

        assert_eq!(layer.name, "Background");
        assert_eq!(layer.opacity, 1.0);
        assert!(layer.image_data.is_none()); // Should use protocol
    }

    #[test]
    fn test_encode_rgba_to_webp_lossless() {
        let img = RgbaImage::new(2, 2);
        let result = encode_rgba_to_webp_lossless(&img);
        assert!(result.is_ok());

        let webp_data = result.unwrap();
        assert!(!webp_data.is_empty());
        // WebP files start with "RIFF"
        assert_eq!(&webp_data[0..4], b"RIFF");
    }

    #[test]
    fn test_blend_mode_conversion() {
        assert_eq!(psd_blend_mode_to_string("Normal"), "normal");
        assert_eq!(psd_blend_mode_to_string("Multiply"), "multiply");
        assert_eq!(psd_blend_mode_to_string("Unknown"), "normal");
    }

    #[test]
    fn test_build_layer_image_layer_bounds() {
        // Test Case 1: layer bounds data
        let rgba = vec![255u8; 4 * 10 * 10]; // 10x10 layer
        let (img, ox, oy) = build_layer_image(&rgba, "test", 100, 200, 10, 10, 1000, 1000).unwrap();

        assert_eq!(img.width(), 10);
        assert_eq!(img.height(), 10);
        assert_eq!(ox, 100);
        assert_eq!(oy, 200);
    }

    #[test]
    fn test_build_layer_image_full_canvas() {
        // Test Case 2: full canvas data
        let rgba = vec![255u8; 4 * 100 * 100]; // 100x100 full canvas
        let (img, ox, oy) = build_layer_image(&rgba, "test", 10, 20, 50, 50, 100, 100).unwrap();

        // Should use full canvas since data matches
        assert_eq!(img.width(), 100);
        assert_eq!(img.height(), 100);
        assert_eq!(ox, 0);
        assert_eq!(oy, 0);
    }
}
