//! TIFF (.tiff) format support with embedded layer data
//!
//! Strategy: "Payload Carrier"
//! - Page 1 (IFD 0): Flattened composite image (viewable in any image viewer)
//! - ImageDescription tag: JSON metadata with layer structure
//! - Page 2..N: Individual layer RGBA data

use super::types::{FileError, LayerData, ProjectData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{ImageFormat, RgbaImage};
use std::fs::File;
use std::io::{BufReader, BufWriter, Cursor};
use std::path::Path;

/// Magic marker in ImageDescription to identify PaintBoard TIFF files
const PAINTBOARD_TIFF_MARKER: &str = "PAINTBOARD_PROJECT_V1:";

/// Layer metadata stored in TIFF (without pixel data)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TiffLayerMeta {
    id: String,
    name: String,
    #[serde(rename = "type")]
    layer_type: String,
    visible: bool,
    locked: bool,
    opacity: f32,
    #[serde(rename = "blendMode")]
    blend_mode: String,
    #[serde(rename = "isBackground")]
    is_background: Option<bool>,
    #[serde(rename = "pageIndex")]
    page_index: usize, // Which TIFF page contains this layer's data
}

/// Project metadata stored in TIFF ImageDescription
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TiffProjectMeta {
    width: u32,
    height: u32,
    dpi: u32,
    layers: Vec<TiffLayerMeta>,
}

/// Decode base64 PNG data to RGBA image
fn decode_base64_png(data: &str) -> Result<RgbaImage, FileError> {
    let base64_data = if let Some(stripped) = data.strip_prefix("data:image/png;base64,") {
        stripped
    } else if data.starts_with("data:") {
        data.split(',').nth(1).unwrap_or(data)
    } else {
        data
    };

    let bytes = BASE64.decode(base64_data)?;
    let img = image::load_from_memory_with_format(&bytes, ImageFormat::Png)?;
    Ok(img.to_rgba8())
}

/// Encode RGBA image to base64 PNG
fn encode_png_to_base64(img: &RgbaImage) -> Result<String, FileError> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)?;
    Ok(BASE64.encode(buf.into_inner()))
}

/// Save project to TIFF file with embedded layer data
pub fn save_tiff(path: &Path, project: &ProjectData) -> Result<(), FileError> {
    use tiff::encoder::{colortype::RGBA8, TiffEncoder};

    let file = File::create(path)?;
    let mut writer = BufWriter::new(file);
    let mut encoder = TiffEncoder::new(&mut writer).map_err(|e| FileError::Tiff(e.to_string()))?;

    // Build layer metadata
    let mut layer_metas = Vec::new();
    for (idx, layer) in project.layers.iter().enumerate() {
        layer_metas.push(TiffLayerMeta {
            id: layer.id.clone(),
            name: layer.name.clone(),
            layer_type: layer.layer_type.clone(),
            visible: layer.visible,
            locked: layer.locked,
            opacity: layer.opacity,
            blend_mode: layer.blend_mode.clone(),
            is_background: layer.is_background,
            page_index: idx + 1, // Page 0 is flattened, layers start at page 1
        });
    }

    let project_meta = TiffProjectMeta {
        width: project.width,
        height: project.height,
        dpi: project.dpi,
        layers: layer_metas,
    };

    // Serialize metadata to JSON
    let meta_json = serde_json::to_string(&project_meta)?;
    let image_description = format!("{}{}", PAINTBOARD_TIFF_MARKER, meta_json);

    // Page 1: Flattened composite image
    let flattened = if let Some(ref flat_data) = project.flattened_image {
        decode_base64_png(flat_data)?
    } else {
        // Create a transparent placeholder if no flattened image provided
        RgbaImage::new(project.width, project.height)
    };

    // Write first page with metadata
    let mut first_page = encoder
        .new_image::<RGBA8>(project.width, project.height)
        .map_err(|e| FileError::Tiff(e.to_string()))?;

    // Set ImageDescription tag (tag 270)
    first_page
        .encoder()
        .write_tag(
            tiff::tags::Tag::ImageDescription,
            image_description.as_str(),
        )
        .map_err(|e| FileError::Tiff(e.to_string()))?;

    // Set resolution
    first_page
        .encoder()
        .write_tag(
            tiff::tags::Tag::XResolution,
            tiff::encoder::Rational {
                n: project.dpi,
                d: 1,
            },
        )
        .map_err(|e| FileError::Tiff(e.to_string()))?;
    first_page
        .encoder()
        .write_tag(
            tiff::tags::Tag::YResolution,
            tiff::encoder::Rational {
                n: project.dpi,
                d: 1,
            },
        )
        .map_err(|e| FileError::Tiff(e.to_string()))?;
    first_page
        .encoder()
        .write_tag(tiff::tags::Tag::ResolutionUnit, 2u16) // Inches
        .map_err(|e| FileError::Tiff(e.to_string()))?;

    // Write flattened image data
    first_page
        .write_data(flattened.as_raw())
        .map_err(|e| FileError::Tiff(e.to_string()))?;

    // Pages 2..N: Individual layer data
    for layer in &project.layers {
        let layer_img = if let Some(ref image_data) = layer.image_data {
            decode_base64_png(image_data)?
        } else {
            // Empty layer
            RgbaImage::new(project.width, project.height)
        };

        let page = encoder
            .new_image::<RGBA8>(project.width, project.height)
            .map_err(|e| FileError::Tiff(e.to_string()))?;

        page.write_data(layer_img.as_raw())
            .map_err(|e| FileError::Tiff(e.to_string()))?;
    }

    Ok(())
}

/// Load project from TIFF file
pub fn load_tiff(path: &Path) -> Result<ProjectData, FileError> {
    use tiff::decoder::Decoder;

    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut decoder = Decoder::new(&mut reader).map_err(|e| FileError::Tiff(e.to_string()))?;

    // Try to read ImageDescription from first page
    let image_description: Option<String> = decoder
        .get_tag_ascii_string(tiff::tags::Tag::ImageDescription)
        .ok();

    // Check if this is a PaintBoard project file
    let project_meta: Option<TiffProjectMeta> = image_description.and_then(|desc| {
        if let Some(json_str) = desc.strip_prefix(PAINTBOARD_TIFF_MARKER) {
            serde_json::from_str(json_str).ok()
        } else {
            None
        }
    });

    if let Some(meta) = project_meta {
        // This is a PaintBoard project - load all layers
        let mut layers = Vec::new();

        // Skip Page 0 (flattened image) - decoder starts at Page 0
        // After this call, decoder is positioned at Page 1
        if decoder.next_image().is_err() {
            return Err(FileError::InvalidFormat(
                "TIFF has no layer pages".to_string(),
            ));
        }

        // Read layers sequentially from Page 1 onwards
        for layer_meta in &meta.layers {
            // Read current page's image data
            let image_data = match decoder.read_image() {
                Ok(tiff::decoder::DecodingResult::U8(data)) => {
                    let (width, height) = decoder.dimensions().unwrap_or((meta.width, meta.height));
                    if let Some(img) = RgbaImage::from_raw(width, height, data) {
                        Some(encode_png_to_base64(&img)?)
                    } else {
                        None
                    }
                }
                _ => None,
            };

            layers.push(LayerData {
                id: layer_meta.id.clone(),
                name: layer_meta.name.clone(),
                layer_type: layer_meta.layer_type.clone(),
                visible: layer_meta.visible,
                locked: layer_meta.locked,
                opacity: layer_meta.opacity,
                blend_mode: layer_meta.blend_mode.clone(),
                is_background: layer_meta.is_background,
                image_data,
                offset_x: 0,
                offset_y: 0,
            });

            // Move to next page for next layer
            let _ = decoder.next_image();
        }

        Ok(ProjectData {
            width: meta.width,
            height: meta.height,
            dpi: meta.dpi,
            layers,
            flattened_image: None,
            thumbnail: None,
            benchmark: None,
        })
    } else {
        // Regular TIFF - import as single background layer
        let (width, height) = decoder
            .dimensions()
            .map_err(|e| FileError::Tiff(e.to_string()))?;

        let image_data = match decoder.read_image() {
            Ok(tiff::decoder::DecodingResult::U8(data)) => {
                if let Some(img) = RgbaImage::from_raw(width, height, data) {
                    Some(encode_png_to_base64(&img)?)
                } else {
                    None
                }
            }
            Ok(tiff::decoder::DecodingResult::U16(data)) => {
                // Convert 16-bit to 8-bit
                let data_u8: Vec<u8> = data.iter().map(|&v| (v >> 8) as u8).collect();
                if let Some(img) = RgbaImage::from_raw(width, height, data_u8) {
                    Some(encode_png_to_base64(&img)?)
                } else {
                    None
                }
            }
            _ => None,
        };

        let layer = LayerData {
            id: format!(
                "imported_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
            name: "Background".to_string(),
            layer_type: "raster".to_string(),
            visible: true,
            locked: false,
            opacity: 1.0,
            blend_mode: "normal".to_string(),
            is_background: Some(true),
            image_data,
            offset_x: 0,
            offset_y: 0,
        };

        Ok(ProjectData {
            width,
            height,
            dpi: 72, // Default DPI
            layers: vec![layer],
            flattened_image: None,
            thumbnail: None,
            benchmark: None,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_tiff_marker() {
        let meta = TiffProjectMeta {
            width: 100,
            height: 100,
            dpi: 72,
            layers: vec![],
        };
        let json = serde_json::to_string(&meta).unwrap();
        let description = format!("{}{}", PAINTBOARD_TIFF_MARKER, json);

        assert!(description.starts_with(PAINTBOARD_TIFF_MARKER));

        let parsed: TiffProjectMeta =
            serde_json::from_str(&description[PAINTBOARD_TIFF_MARKER.len()..]).unwrap();
        assert_eq!(parsed.width, 100);
    }
}
