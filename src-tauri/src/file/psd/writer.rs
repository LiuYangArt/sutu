//! PSD file writer
//!
//! Implements PSD export with full layer support.

use super::blend_mode_to_psd;
use super::compression::encode_channel;
use super::types::{
    ChannelInfo, ImageResourceId, LayerFlags, PreparedChannel, PreparedLayer, PsdHeader,
    ResolutionInfo,
};
use crate::file::types::{FileError, LayerData, ProjectData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use byteorder::{BigEndian, WriteBytesExt};
use image::{ImageFormat, RgbaImage};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// Save project to PSD file
pub fn save_psd(path: &Path, project: &ProjectData) -> Result<(), FileError> {
    tracing::info!("Saving PSD file: {:?}", path);

    let file = File::create(path)?;
    let mut writer = BufWriter::new(file);

    // 1. Prepare all layers (pre-compress channel data)
    let prepared_layers = prepare_layers(project)?;

    // 2. Write File Header
    let header = PsdHeader::new_rgba(project.width, project.height);
    header.write(&mut writer)?;

    // 3. Write Color Mode Data (empty for RGB)
    writer.write_u32::<BigEndian>(0)?;

    // 4. Write Image Resources
    write_image_resources(&mut writer, project.dpi)?;

    // 5. Write Layer and Mask Information
    write_layer_section(&mut writer, &prepared_layers, project.height)?;

    // 6. Write Image Data (composite/merged image)
    write_composite_image(&mut writer, project)?;

    writer.flush()?;

    tracing::info!("PSD file saved successfully");
    Ok(())
}

/// Prepare all layers for writing (pre-compress channel data)
fn prepare_layers(project: &ProjectData) -> Result<Vec<PreparedLayer>, FileError> {
    let mut prepared = Vec::with_capacity(project.layers.len());

    // Keep project layer order as-is.
    // Sutu's current layer array order already matches Photoshop export expectation.
    for layer in project.layers.iter() {
        if let Some(ref image_data) = layer.image_data {
            let prepared_layer = prepare_layer(layer, image_data, project.width, project.height)?;
            prepared.push(prepared_layer);
        }
    }

    Ok(prepared)
}

/// Prepare a single layer
fn prepare_layer(
    layer: &LayerData,
    image_data: &str,
    doc_width: u32,
    doc_height: u32,
) -> Result<PreparedLayer, FileError> {
    // Decode base64 PNG to RGBA
    let img = decode_base64_png(image_data)?;

    // For simplicity, use full canvas bounds
    // TODO: Optimize by calculating actual non-transparent bounds
    let top = 0i32;
    let left = 0i32;
    let bottom = doc_height as i32;
    let right = doc_width as i32;

    // Prepare channels (Alpha, Red, Green, Blue)
    let channels = prepare_channels(&img, doc_width, doc_height)?;

    let flags = LayerFlags {
        visible: layer.visible,
        has_useful_info: true,
        ..Default::default()
    };

    Ok(PreparedLayer {
        name: layer.name.clone(),
        top,
        left,
        bottom,
        right,
        opacity: (layer.opacity * 255.0).round() as u8,
        blend_mode: blend_mode_to_psd(&layer.blend_mode),
        flags,
        channels,
    })
}

/// Prepare channel data for a layer
fn prepare_channels(
    img: &RgbaImage,
    width: u32,
    height: u32,
) -> Result<Vec<PreparedChannel>, FileError> {
    let mut channels = Vec::with_capacity(4);

    // Channel order: Alpha (-1), Red (0), Green (1), Blue (2)
    let channel_ids = [-1i16, 0, 1, 2];

    for (ch_idx, &channel_id) in channel_ids.iter().enumerate() {
        // Extract channel data row by row
        let mut rows: Vec<Vec<u8>> = Vec::with_capacity(height as usize);

        for y in 0..height {
            let mut row = Vec::with_capacity(width as usize);
            for x in 0..width {
                let pixel = img.get_pixel(x, y);
                let value = match ch_idx {
                    0 => pixel[3], // Alpha
                    1 => pixel[0], // Red
                    2 => pixel[1], // Green
                    3 => pixel[2], // Blue
                    _ => 0,
                };
                row.push(value);
            }
            rows.push(row);
        }

        // Compress channel
        let row_refs: Vec<&[u8]> = rows.iter().map(|r| r.as_slice()).collect();
        let (row_counts, compressed_data) = encode_channel(&row_refs);

        channels.push(PreparedChannel {
            id: channel_id,
            row_counts,
            compressed_data,
        });
    }

    Ok(channels)
}

/// Write Image Resources section
fn write_image_resources<W: Write>(w: &mut W, dpi: u32) -> Result<(), FileError> {
    let mut buffer = Vec::new();

    // Write ResolutionInfo resource (0x03ED)
    write_image_resource(&mut buffer, ImageResourceId::ResolutionInfo as u16, |buf| {
        let res_info = ResolutionInfo::new(dpi);
        res_info.write(buf)?;
        Ok(())
    })?;

    // Write section length and data
    w.write_u32::<BigEndian>(buffer.len() as u32)?;
    w.write_all(&buffer)?;

    Ok(())
}

/// Write a single image resource
fn write_image_resource<W: Write, F>(w: &mut W, id: u16, write_data: F) -> Result<(), FileError>
where
    F: FnOnce(&mut Vec<u8>) -> Result<(), FileError>,
{
    // Resource signature
    w.write_all(b"8BIM")?;

    // Resource ID
    w.write_u16::<BigEndian>(id)?;

    // Pascal string (name) - empty
    w.write_u8(0)?; // Length
    w.write_u8(0)?; // Padding to even

    // Write data to temp buffer to get length
    let mut data = Vec::new();
    write_data(&mut data)?;

    // Data length
    w.write_u32::<BigEndian>(data.len() as u32)?;

    // Data
    w.write_all(&data)?;

    // Pad to even length
    if data.len() % 2 != 0 {
        w.write_u8(0)?;
    }

    Ok(())
}

/// Write Layer and Mask Information section
fn write_layer_section<W: Write>(
    w: &mut W,
    layers: &[PreparedLayer],
    _height: u32,
) -> Result<(), FileError> {
    if layers.is_empty() {
        // Empty layer section
        w.write_u32::<BigEndian>(0)?;
        return Ok(());
    }

    let mut layer_info = Vec::new();

    // Layer count (negative = has alpha channel in merged result)
    layer_info.write_i16::<BigEndian>(-(layers.len() as i16))?;

    // Write all layer records
    for layer in layers {
        write_layer_record(&mut layer_info, layer)?;
    }

    // Write channel image data for all layers
    for layer in layers {
        for channel in &layer.channels {
            // Compression type (1 = RLE)
            layer_info.write_u16::<BigEndian>(1)?;

            // Row byte counts
            for &count in &channel.row_counts {
                layer_info.write_u16::<BigEndian>(count)?;
            }

            // Compressed data
            layer_info.write_all(&channel.compressed_data)?;
        }
    }

    // Pad Layer Info to multiple of 4
    while layer_info.len() % 4 != 0 {
        layer_info.push(0);
    }

    // Write Layer and Mask Info section
    // Length = Layer Info length + 4 (for Layer Info length field) + 4 (for Global Layer Mask)
    let section_length = 4 + layer_info.len() + 4;
    w.write_u32::<BigEndian>(section_length as u32)?;

    // Layer Info length
    w.write_u32::<BigEndian>(layer_info.len() as u32)?;

    // Layer Info data
    w.write_all(&layer_info)?;

    // Global Layer Mask Info (empty)
    w.write_u32::<BigEndian>(0)?;

    Ok(())
}

/// Write a single layer record
fn write_layer_record<W: Write>(w: &mut W, layer: &PreparedLayer) -> Result<(), FileError> {
    // Bounds
    w.write_i32::<BigEndian>(layer.top)?;
    w.write_i32::<BigEndian>(layer.left)?;
    w.write_i32::<BigEndian>(layer.bottom)?;
    w.write_i32::<BigEndian>(layer.right)?;

    // Number of channels
    w.write_u16::<BigEndian>(layer.channels.len() as u16)?;

    // Channel info
    for channel in &layer.channels {
        let info = ChannelInfo {
            id: channel.id,
            data_length: channel.data_length(),
        };
        info.write(w)?;
    }

    // Blend mode signature
    w.write_all(b"8BIM")?;

    // Blend mode key
    w.write_all(&layer.blend_mode)?;

    // Opacity
    w.write_u8(layer.opacity)?;

    // Clipping (0 = base)
    w.write_u8(0)?;

    // Flags
    w.write_u8(layer.flags.to_byte())?;

    // Filler
    w.write_u8(0)?;

    // Extra data length
    let extra_data = build_extra_data(layer)?;
    w.write_u32::<BigEndian>(extra_data.len() as u32)?;

    // Extra data
    w.write_all(&extra_data)?;

    Ok(())
}

/// Build extra data for layer record
fn build_extra_data(layer: &PreparedLayer) -> Result<Vec<u8>, FileError> {
    let mut extra = Vec::new();

    // Layer mask data (empty)
    extra.write_u32::<BigEndian>(0)?;

    // Layer blending ranges (empty)
    extra.write_u32::<BigEndian>(0)?;

    // Layer name (Pascal string, padded to 4 bytes)
    write_pascal_string(&mut extra, &layer.name)?;

    Ok(extra)
}

/// Write Pascal string padded to 4 bytes
fn write_pascal_string<W: Write>(w: &mut W, s: &str) -> Result<(), FileError> {
    let bytes = s.as_bytes();
    let len = bytes.len().min(255);

    // Length byte + string bytes
    let total = 1 + len;

    // Pad to multiple of 4
    let padded_len = (total + 3) & !3;

    w.write_u8(len as u8)?;
    w.write_all(&bytes[..len])?;

    // Write padding
    for _ in total..padded_len {
        w.write_u8(0)?;
    }

    Ok(())
}

/// Write composite (merged) image data
fn write_composite_image<W: Write>(w: &mut W, project: &ProjectData) -> Result<(), FileError> {
    // Prefer frontend flattened export to guarantee WYSIWYG with canvas blend modes.
    // Fallback to backend layer flattening only when flattened image is missing/invalid.
    let composite = create_composite(project)?;

    let width = project.width;
    let height = project.height;

    // Compression method (1 = RLE)
    w.write_u16::<BigEndian>(1)?;

    // Prepare all channels
    let mut all_row_counts: Vec<u16> = Vec::new();
    let mut all_channel_data: Vec<u8> = Vec::new();

    // Channel order for composite: R, G, B, A
    for ch_idx in 0..4 {
        let mut rows: Vec<Vec<u8>> = Vec::with_capacity(height as usize);

        for y in 0..height {
            let mut row = Vec::with_capacity(width as usize);
            for x in 0..width {
                let pixel = composite.get_pixel(x, y);
                let value = match ch_idx {
                    0 => pixel[0], // Red
                    1 => pixel[1], // Green
                    2 => pixel[2], // Blue
                    3 => pixel[3], // Alpha
                    _ => 0,
                };
                row.push(value);
            }
            rows.push(row);
        }

        let row_refs: Vec<&[u8]> = rows.iter().map(|r| r.as_slice()).collect();
        let (row_counts, compressed_data) = encode_channel(&row_refs);

        all_row_counts.extend(row_counts);
        all_channel_data.extend(compressed_data);
    }

    // Write all row counts first
    for count in &all_row_counts {
        w.write_u16::<BigEndian>(*count)?;
    }

    // Write all compressed data
    w.write_all(&all_channel_data)?;

    Ok(())
}

/// Create composite image for PSD merged data
fn create_composite(project: &ProjectData) -> Result<RgbaImage, FileError> {
    if let Some(ref flattened_data) = project.flattened_image {
        let flattened = decode_base64_png(flattened_data)?;
        if flattened.width() == project.width && flattened.height() == project.height {
            return Ok(flattened);
        }
        tracing::warn!(
            "PSD flattened image size mismatch: expected {}x{}, got {}x{}, fallback to backend composite",
            project.width,
            project.height,
            flattened.width(),
            flattened.height()
        );
    }

    create_composite_from_layers(project)
}

/// Create composite image from layer stack as fallback path
fn create_composite_from_layers(project: &ProjectData) -> Result<RgbaImage, FileError> {
    let mut composite = RgbaImage::new(project.width, project.height);

    // Fill with white background
    for pixel in composite.pixels_mut() {
        *pixel = image::Rgba([255, 255, 255, 255]);
    }

    // Composite each visible layer (bottom to top)
    for layer in &project.layers {
        if !layer.visible {
            continue;
        }

        if let Some(ref image_data) = layer.image_data {
            let layer_img = decode_base64_png(image_data)?;
            let opacity = layer.opacity;

            // Simple alpha blending
            for y in 0..project.height {
                for x in 0..project.width {
                    let src = layer_img.get_pixel(x, y);
                    let dst = composite.get_pixel(x, y);

                    let src_a = (src[3] as f32 / 255.0) * opacity;

                    if src_a > 0.0 {
                        let dst_a = dst[3] as f32 / 255.0;
                        let out_a = src_a + dst_a * (1.0 - src_a);

                        if out_a > 0.0 {
                            let blend = |s: u8, d: u8| -> u8 {
                                let s_f = s as f32 / 255.0;
                                let d_f = d as f32 / 255.0;
                                let out = (s_f * src_a + d_f * dst_a * (1.0 - src_a)) / out_a;
                                (out * 255.0).round() as u8
                            };

                            let out_pixel = image::Rgba([
                                blend(src[0], dst[0]),
                                blend(src[1], dst[1]),
                                blend(src[2], dst[2]),
                                (out_a * 255.0).round() as u8,
                            ]);
                            composite.put_pixel(x, y, out_pixel);
                        }
                    }
                }
            }
        }
    }

    Ok(composite)
}

/// Decode base64 PNG to RGBA image
fn decode_base64_png(data: &str) -> Result<RgbaImage, FileError> {
    // Handle data URL prefix
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::file::types::LayerData;
    use image::{ImageBuffer, ImageFormat, Rgba};

    #[test]
    fn test_write_pascal_string() {
        let mut buf = Vec::new();
        write_pascal_string(&mut buf, "Test").unwrap();
        // Length(1) + "Test"(4) = 5, padded to 8
        assert_eq!(buf.len(), 8);
        assert_eq!(buf[0], 4); // Length
        assert_eq!(&buf[1..5], b"Test");
    }

    #[test]
    fn test_write_pascal_string_short() {
        let mut buf = Vec::new();
        write_pascal_string(&mut buf, "AB").unwrap();
        // Length(1) + "AB"(2) = 3, padded to 4
        assert_eq!(buf.len(), 4);
    }

    #[test]
    fn test_create_composite_empty() {
        let project = ProjectData {
            width: 10,
            height: 10,
            dpi: 72,
            layers: vec![],
            flattened_image: None,
            thumbnail: None,
            benchmark: None,
        };

        let result = create_composite(&project);
        assert!(result.is_ok());

        let img = result.unwrap();
        assert_eq!(img.width(), 10);
        assert_eq!(img.height(), 10);
    }

    #[test]
    fn test_prepare_layers_preserves_project_order() {
        let image_data = {
            let img = ImageBuffer::from_pixel(1, 1, Rgba([255, 0, 0, 255]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut cursor, ImageFormat::Png)
                .expect("encode png");
            format!(
                "data:image/png;base64,{}",
                BASE64.encode(cursor.into_inner())
            )
        };

        let project = ProjectData {
            width: 1,
            height: 1,
            dpi: 72,
            layers: vec![
                LayerData {
                    id: "bottom".to_string(),
                    name: "Bottom".to_string(),
                    layer_type: "raster".to_string(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend_mode: "normal".to_string(),
                    is_background: Some(true),
                    image_data: Some(image_data.clone()),
                    offset_x: 0,
                    offset_y: 0,
                },
                LayerData {
                    id: "top".to_string(),
                    name: "Top".to_string(),
                    layer_type: "raster".to_string(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend_mode: "difference".to_string(),
                    is_background: Some(false),
                    image_data: Some(image_data),
                    offset_x: 0,
                    offset_y: 0,
                },
            ],
            flattened_image: None,
            thumbnail: None,
            benchmark: None,
        };

        let prepared = prepare_layers(&project).expect("prepare layers");
        assert_eq!(prepared.len(), 2);
        assert_eq!(prepared[0].name, "Bottom");
        assert_eq!(prepared[1].name, "Top");
    }
}
