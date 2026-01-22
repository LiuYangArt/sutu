//! PSD file reader using the `psd` crate
//!
//! Converts PSD files to PaintBoard's ProjectData format.

use crate::file::types::{FileError, LayerData, ProjectData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{ImageFormat, RgbaImage};
use psd::Psd;
use std::io::Cursor;
use std::path::Path;

/// Load a PSD file and convert to ProjectData
pub fn load_psd(path: &Path) -> Result<ProjectData, FileError> {
    tracing::info!("Loading PSD file: {:?}", path);

    let data = std::fs::read(path)?;
    let psd = Psd::from_bytes(&data)
        .map_err(|e| FileError::InvalidFormat(format!("PSD parse error: {}", e)))?;

    let width = psd.width();
    let height = psd.height();

    tracing::debug!("PSD dimensions: {}x{}", width, height);

    // Convert layers
    let mut layers = Vec::new();

    for (idx, psd_layer) in psd.layers().iter().enumerate() {
        match convert_psd_layer(psd_layer, idx, width, height) {
            Ok(layer) => {
                tracing::debug!(
                    "Converted layer {}: '{}' ({}x{})",
                    idx,
                    layer.name,
                    psd_layer.width(),
                    psd_layer.height()
                );
                layers.push(layer);
            }
            Err(e) => {
                tracing::warn!("Failed to convert layer {}: {}", idx, e);
            }
        }
    }

    // If no layers were converted, create a background from composite
    if layers.is_empty() {
        tracing::info!("No layers found, using composite image as background");
        let composite = psd.rgba();
        let layer = create_background_layer(&composite, width, height)?;
        layers.push(layer);
    }

    // Reverse layers to match PaintBoard's bottom-to-top order
    // PSD stores layers top-to-bottom
    layers.reverse();

    tracing::info!("Loaded {} layers from PSD", layers.len());

    Ok(ProjectData {
        width,
        height,
        dpi: 72, // PSD doesn't expose DPI easily through psd crate
        layers,
        flattened_image: None,
        thumbnail: None,
    })
}

/// Convert a PSD layer to LayerData
fn convert_psd_layer(
    psd_layer: &psd::PsdLayer,
    idx: usize,
    doc_width: u32,
    doc_height: u32,
) -> Result<LayerData, FileError> {
    // IMPORTANT: psd crate's layer.rgba() returns FULL CANVAS SIZE data,
    // with the layer content placed at the correct offset position.
    // So we should use doc_width × doc_height, not layer_width × layer_height.
    let rgba_data = psd_layer.rgba();

    // Validate that rgba_data is the expected size (full canvas)
    let expected_size = (doc_width * doc_height * 4) as usize;

    let full_image = if rgba_data.len() == expected_size {
        // rgba_data is full canvas size - use directly
        RgbaImage::from_raw(doc_width, doc_height, rgba_data)
            .ok_or_else(|| FileError::InvalidFormat("Invalid layer RGBA data".into()))?
    } else {
        // Fallback: try to interpret as layer-sized data (for compatibility)
        tracing::warn!(
            "Layer '{}': RGBA data size {} doesn't match expected {} ({}x{}x4), trying layer bounds",
            psd_layer.name(),
            rgba_data.len(),
            expected_size,
            doc_width,
            doc_height
        );

        // Use layer bounds for sizing
        let layer_width = (psd_layer.layer_right() - psd_layer.layer_left()) as u32;
        let layer_height = (psd_layer.layer_bottom() - psd_layer.layer_top()) as u32;
        let layer_expected = (layer_width * layer_height * 4) as usize;

        if rgba_data.len() == layer_expected && layer_width > 0 && layer_height > 0 {
            // Data matches layer bounds - composite onto full canvas
            let mut full_image = RgbaImage::new(doc_width, doc_height);
            if let Some(layer_img) = RgbaImage::from_raw(layer_width, layer_height, rgba_data) {
                let offset_x = psd_layer.layer_left();
                let offset_y = psd_layer.layer_top();

                for y in 0..layer_height {
                    for x in 0..layer_width {
                        let dest_x = offset_x + x as i32;
                        let dest_y = offset_y + y as i32;

                        if dest_x >= 0
                            && dest_x < doc_width as i32
                            && dest_y >= 0
                            && dest_y < doc_height as i32
                        {
                            let pixel = layer_img.get_pixel(x, y);
                            full_image.put_pixel(dest_x as u32, dest_y as u32, *pixel);
                        }
                    }
                }
            }
            full_image
        } else {
            // Cannot determine correct size - create empty layer
            tracing::error!(
                "Layer '{}': Cannot parse RGBA data (got {} bytes, layer bounds {}x{})",
                psd_layer.name(),
                rgba_data.len(),
                layer_width,
                layer_height
            );
            RgbaImage::new(doc_width, doc_height)
        }
    };

    // Encode to base64 PNG
    let image_data = encode_png_to_base64(&full_image)?;

    // Get blend mode - use Debug trait since BlendMode is not publicly exported
    let blend_mode = psd_blend_mode_to_string(&format!("{:?}", psd_layer.blend_mode()));

    Ok(LayerData {
        id: format!("psd_layer_{}", idx),
        name: psd_layer.name().to_string(),
        layer_type: "raster".to_string(),
        // WORKAROUND: psd crate has inverted visible flag logic
        // PSD spec: bit 1 = 1 means HIDDEN, but psd crate interprets it as VISIBLE
        // So we need to invert the value
        visible: !psd_layer.visible(),
        locked: false,
        opacity: psd_layer.opacity() as f32 / 255.0,
        blend_mode,
        is_background: Some(idx == 0),
        image_data: Some(image_data),
        offset_x: 0, // Already composited into full image
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

/// Create a background layer from composite image data
fn create_background_layer(
    rgba_data: &[u8],
    width: u32,
    height: u32,
) -> Result<LayerData, FileError> {
    let img = RgbaImage::from_raw(width, height, rgba_data.to_vec())
        .ok_or_else(|| FileError::InvalidFormat("Invalid composite image data".into()))?;

    let image_data = encode_png_to_base64(&img)?;

    Ok(LayerData {
        id: "psd_background".to_string(),
        name: "Background".to_string(),
        layer_type: "raster".to_string(),
        visible: true,
        locked: false,
        opacity: 1.0,
        blend_mode: "normal".to_string(),
        is_background: Some(true),
        image_data: Some(image_data),
        offset_x: 0,
        offset_y: 0,
    })
}

/// Encode RGBA image to base64 PNG string
fn encode_png_to_base64(img: &RgbaImage) -> Result<String, FileError> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)?;
    Ok(BASE64.encode(buf.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_background_layer() {
        let rgba = vec![255u8; 4 * 10 * 10]; // 10x10 white image
        let layer = create_background_layer(&rgba, 10, 10).unwrap();

        assert_eq!(layer.name, "Background");
        assert_eq!(layer.opacity, 1.0);
        assert!(layer.image_data.is_some());
    }

    #[test]
    fn test_encode_png_to_base64() {
        let img = RgbaImage::new(2, 2);
        let result = encode_png_to_base64(&img);
        assert!(result.is_ok());

        let base64_str = result.unwrap();
        assert!(!base64_str.is_empty());
    }
}
