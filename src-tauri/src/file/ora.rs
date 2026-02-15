//! OpenRaster (.ora) format support
//!
//! ORA is a ZIP archive containing:
//! - mimetype: "image/openraster" (stored, not compressed)
//! - stack.xml: Layer structure and metadata
//! - Thumbnails/thumbnail.png: 256x256 preview
//! - data/*.png: Individual layer pixel data

use super::layer_cache::{cache_layer_png, cache_thumbnail, clear_cache};
use super::types::{FileError, LayerData, ProjectData};
use crate::app_meta::{APP_ORA_LEGACY_NAMESPACE, APP_ORA_NAMESPACE};
use crate::benchmark::{generate_session_id, BackendBenchmark};
use crate::core::contracts::ProjectDataCore;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{ImageFormat, RgbaImage};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Write};
use std::path::Path;
use std::time::Instant;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const ORA_MIMETYPE: &str = "image/openraster";

fn ora_attr_key(name: &str) -> String {
    format!("{}:{}", APP_ORA_NAMESPACE, name)
}

fn ora_legacy_attr_key(name: &str) -> String {
    format!("{}:{}", APP_ORA_LEGACY_NAMESPACE, name)
}

struct OraLayerXml<'a> {
    id: &'a str,
    name: &'a str,
    layer_type: &'a str,
    visible: bool,
    locked: bool,
    opacity: f32,
    blend_mode: &'a str,
    is_background: Option<bool>,
    offset_x: i32,
    offset_y: i32,
}

fn write_layer_xml(
    writer: &mut Writer<Cursor<Vec<u8>>>,
    layer: OraLayerXml<'_>,
) -> Result<(), FileError> {
    let mut layer_elem = BytesStart::new("layer");
    layer_elem.push_attribute(("name", layer.name));
    layer_elem.push_attribute(("src", format!("data/{}.png", layer.id).as_str()));
    layer_elem.push_attribute(("x", layer.offset_x.to_string().as_str()));
    layer_elem.push_attribute(("y", layer.offset_y.to_string().as_str()));
    layer_elem.push_attribute(("composite-op", blend_mode_to_ora(layer.blend_mode)));
    layer_elem.push_attribute(("opacity", layer.opacity.to_string().as_str()));
    layer_elem.push_attribute((
        "visibility",
        if layer.visible { "visible" } else { "hidden" },
    ));

    let attr_id = ora_attr_key("id");
    let attr_type = ora_attr_key("type");
    let attr_locked = ora_attr_key("locked");
    layer_elem.push_attribute((attr_id.as_str(), layer.id));
    layer_elem.push_attribute((attr_type.as_str(), layer.layer_type));
    layer_elem.push_attribute((attr_locked.as_str(), layer.locked.to_string().as_str()));
    if let Some(is_bg) = layer.is_background {
        let attr_is_background = ora_attr_key("is-background");
        layer_elem.push_attribute((attr_is_background.as_str(), is_bg.to_string().as_str()));
    }

    writer.write_event(Event::Empty(layer_elem))?;
    Ok(())
}

fn resize_thumbnail_if_needed(thumb_img: RgbaImage) -> RgbaImage {
    if thumb_img.width() != 256 || thumb_img.height() != 256 {
        image::imageops::resize(&thumb_img, 256, 256, image::imageops::FilterType::Lanczos3)
    } else {
        thumb_img
    }
}

fn write_thumbnail_entry(
    zip: &mut ZipWriter<File>,
    options_deflate: SimpleFileOptions,
    thumbnail_img: RgbaImage,
) -> Result<(), FileError> {
    let thumb_resized = resize_thumbnail_if_needed(thumbnail_img);
    let mut thumb_data = Cursor::new(Vec::new());
    thumb_resized.write_to(&mut thumb_data, ImageFormat::Png)?;

    zip.add_directory("Thumbnails", options_deflate)?;
    zip.start_file("Thumbnails/thumbnail.png", options_deflate)?;
    zip.write_all(&thumb_data.into_inner())?;
    Ok(())
}

/// Map Sutu blend mode to ORA/SVG composite operation
fn blend_mode_to_ora(mode: &str) -> &'static str {
    match mode {
        "normal" => "svg:src-over",
        "multiply" => "svg:multiply",
        "screen" => "svg:screen",
        "overlay" => "svg:overlay",
        "darken" => "svg:darken",
        "lighten" => "svg:lighten",
        "color-dodge" => "svg:color-dodge",
        "color-burn" => "svg:color-burn",
        "hard-light" => "svg:hard-light",
        "soft-light" => "svg:soft-light",
        "difference" => "svg:difference",
        "exclusion" => "svg:exclusion",
        "hue" => "svg:hue",
        "saturation" => "svg:saturation",
        "color" => "svg:color",
        "luminosity" => "svg:luminosity",
        _ => "svg:src-over",
    }
}

/// Map ORA/SVG composite operation to Sutu blend mode
fn ora_to_blend_mode(composite_op: &str) -> String {
    match composite_op {
        "svg:src-over" => "normal",
        "svg:multiply" => "multiply",
        "svg:screen" => "screen",
        "svg:overlay" => "overlay",
        "svg:darken" => "darken",
        "svg:lighten" => "lighten",
        "svg:color-dodge" => "color-dodge",
        "svg:color-burn" => "color-burn",
        "svg:hard-light" => "hard-light",
        "svg:soft-light" => "soft-light",
        "svg:difference" => "difference",
        "svg:exclusion" => "exclusion",
        "svg:hue" => "hue",
        "svg:saturation" => "saturation",
        "svg:color" => "color",
        "svg:luminosity" => "luminosity",
        _ => "normal",
    }
    .to_string()
}

/// Generate stack.xml content from project data
fn generate_stack_xml(project: &ProjectData) -> Result<Vec<u8>, FileError> {
    let mut writer = Writer::new(Cursor::new(Vec::new()));

    // XML declaration
    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;

    // Root <image> element
    let mut image_start = BytesStart::new("image");
    image_start.push_attribute(("w", project.width.to_string().as_str()));
    image_start.push_attribute(("h", project.height.to_string().as_str()));
    writer.write_event(Event::Start(image_start))?;

    // Main <stack> element (contains all layers)
    let mut stack_start = BytesStart::new("stack");
    stack_start.push_attribute(("composite-op", "svg:src-over"));
    stack_start.push_attribute(("opacity", "1.0"));
    stack_start.push_attribute(("visibility", "visible"));
    writer.write_event(Event::Start(stack_start))?;

    // Write layers (in reverse order - ORA uses top-to-bottom, we use bottom-to-top)
    for layer in project.layers.iter().rev() {
        write_layer_xml(
            &mut writer,
            OraLayerXml {
                id: layer.id.as_str(),
                name: layer.name.as_str(),
                layer_type: layer.layer_type.as_str(),
                visible: layer.visible,
                locked: layer.locked,
                opacity: layer.opacity,
                blend_mode: layer.blend_mode.as_str(),
                is_background: layer.is_background,
                offset_x: layer.offset_x,
                offset_y: layer.offset_y,
            },
        )?;
    }

    // Close stack and image
    writer.write_event(Event::End(BytesEnd::new("stack")))?;
    writer.write_event(Event::End(BytesEnd::new("image")))?;

    Ok(writer.into_inner().into_inner())
}

/// Generate stack.xml content from project core data
fn generate_stack_xml_core(project: &ProjectDataCore) -> Result<Vec<u8>, FileError> {
    let mut writer = Writer::new(Cursor::new(Vec::new()));

    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;

    let mut image_start = BytesStart::new("image");
    image_start.push_attribute(("w", project.width.to_string().as_str()));
    image_start.push_attribute(("h", project.height.to_string().as_str()));
    writer.write_event(Event::Start(image_start))?;

    let mut stack_start = BytesStart::new("stack");
    stack_start.push_attribute(("composite-op", "svg:src-over"));
    stack_start.push_attribute(("opacity", "1.0"));
    stack_start.push_attribute(("visibility", "visible"));
    writer.write_event(Event::Start(stack_start))?;

    for layer in project.layers.iter().rev() {
        write_layer_xml(
            &mut writer,
            OraLayerXml {
                id: layer.id.as_str(),
                name: layer.name.as_str(),
                layer_type: layer.layer_type.as_str(),
                visible: layer.visible,
                locked: layer.locked,
                opacity: layer.opacity,
                blend_mode: layer.blend_mode.as_str(),
                is_background: layer.is_background,
                offset_x: layer.offset_x,
                offset_y: layer.offset_y,
            },
        )?;
    }

    writer.write_event(Event::End(BytesEnd::new("stack")))?;
    writer.write_event(Event::End(BytesEnd::new("image")))?;

    Ok(writer.into_inner().into_inner())
}
/// Decode base64 PNG data to raw RGBA bytes
fn decode_base64_png(data: &str) -> Result<RgbaImage, FileError> {
    // Handle data URL prefix if present
    let base64_data = if let Some(stripped) = data.strip_prefix("data:image/png;base64,") {
        stripped
    } else if data.starts_with("data:") {
        // Skip any data URL prefix
        data.split(',').nth(1).unwrap_or(data)
    } else {
        data
    };

    let bytes = BASE64.decode(base64_data)?;
    let img = image::load_from_memory_with_format(&bytes, ImageFormat::Png)?;
    Ok(img.to_rgba8())
}

/// Save project to ORA file
pub fn save_ora(path: &Path, project: &ProjectData) -> Result<(), FileError> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);

    // 1. Write mimetype (MUST be first, stored without compression)
    let options_stored = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);

    zip.start_file("mimetype", options_stored)?;
    zip.write_all(ORA_MIMETYPE.as_bytes())?;

    // Default options with compression for other files
    let options_deflate = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 2. Write stack.xml
    let stack_xml = generate_stack_xml(project)?;
    zip.start_file("stack.xml", options_deflate)?;
    zip.write_all(&stack_xml)?;

    // 3. Write layer data
    for layer in &project.layers {
        if let Some(ref image_data) = layer.image_data {
            let img = decode_base64_png(image_data)?;
            let mut png_data = Cursor::new(Vec::new());
            img.write_to(&mut png_data, ImageFormat::Png)?;

            let layer_path = format!("data/{}.png", layer.id);
            zip.start_file(&layer_path, options_deflate)?;
            zip.write_all(&png_data.into_inner())?;
        }
    }

    // 4. Write thumbnail if provided
    if let Some(ref thumbnail) = project.thumbnail {
        let thumb_img = decode_base64_png(thumbnail)?;
        write_thumbnail_entry(&mut zip, options_deflate, thumb_img)?;
    }

    zip.finish()?;
    Ok(())
}

/// Save project core data to ORA file using bytes-first payload.
pub fn save_ora_core(path: &Path, project: &ProjectDataCore) -> Result<(), FileError> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);

    let options_stored = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    zip.start_file("mimetype", options_stored)?;
    zip.write_all(ORA_MIMETYPE.as_bytes())?;

    let options_deflate = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let stack_xml = generate_stack_xml_core(project)?;
    zip.start_file("stack.xml", options_deflate)?;
    zip.write_all(&stack_xml)?;

    for layer in &project.layers {
        if let Some(ref png_bytes) = layer.layer_png_bytes {
            let layer_path = format!("data/{}.png", layer.id);
            zip.start_file(&layer_path, options_deflate)?;
            zip.write_all(png_bytes)?;
        }
    }

    if let Some(ref thumbnail_png_bytes) = project.thumbnail_png_bytes {
        let thumb_img =
            image::load_from_memory_with_format(thumbnail_png_bytes, ImageFormat::Png)?.to_rgba8();
        write_thumbnail_entry(&mut zip, options_deflate, thumb_img)?;
    }

    zip.finish()?;
    Ok(())
}

/// Parse stack.xml and extract layer information
fn parse_stack_xml(
    xml_data: &[u8],
    _project_width: u32,
    _project_height: u32,
) -> Result<Vec<LayerData>, FileError> {
    let attr_id = ora_attr_key("id");
    let attr_type = ora_attr_key("type");
    let attr_locked = ora_attr_key("locked");
    let attr_is_background = ora_attr_key("is-background");
    let legacy_attr_id = ora_legacy_attr_key("id");
    let legacy_attr_type = ora_legacy_attr_key("type");
    let legacy_attr_locked = ora_legacy_attr_key("locked");
    let legacy_attr_is_background = ora_legacy_attr_key("is-background");

    let mut reader = Reader::from_reader(xml_data);
    reader.trim_text(true);

    let mut layers = Vec::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) if e.name().as_ref() == b"layer" => {
                let mut layer = LayerData {
                    id: String::new(),
                    name: String::new(),
                    layer_type: "raster".to_string(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend_mode: "normal".to_string(),
                    is_background: None,
                    image_data: None,
                    offset_x: 0,
                    offset_y: 0,
                };

                let mut src_path = String::new();

                for attr in e.attributes().flatten() {
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let value = String::from_utf8_lossy(&attr.value).to_string();

                    match key.as_str() {
                        "name" => layer.name = value,
                        "src" => src_path = value,
                        "x" => layer.offset_x = value.parse().unwrap_or(0),
                        "y" => layer.offset_y = value.parse().unwrap_or(0),
                        "composite-op" => layer.blend_mode = ora_to_blend_mode(&value),
                        "opacity" => layer.opacity = value.parse().unwrap_or(1.0),
                        "visibility" => layer.visible = value != "hidden",
                        _ if key == attr_id || key == legacy_attr_id => layer.id = value,
                        _ if key == attr_type || key == legacy_attr_type => {
                            layer.layer_type = value;
                        }
                        _ if key == attr_locked || key == legacy_attr_locked => {
                            layer.locked = value == "true";
                        }
                        _ if key == attr_is_background || key == legacy_attr_is_background => {
                            layer.is_background = Some(value == "true");
                        }
                        _ => {}
                    }
                }

                // Generate ID from src path if not provided
                if layer.id.is_empty() {
                    layer.id = src_path
                        .trim_start_matches("data/")
                        .trim_end_matches(".png")
                        .to_string();
                }

                // Use filename as name if not provided
                if layer.name.is_empty() {
                    layer.name = layer.id.clone();
                }

                // Store src path temporarily in image_data for later loading
                layer.image_data = Some(src_path);

                layers.push(layer);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(FileError::Xml(format!("XML parse error: {}", e))),
            _ => {}
        }
        buf.clear();
    }

    // Reverse layers (ORA is top-to-bottom, we use bottom-to-top)
    layers.reverse();

    Ok(layers)
}

/// Load project from ORA file
pub fn load_ora(path: &Path) -> Result<ProjectData, FileError> {
    let total_start = Instant::now();
    let session_id = generate_session_id();
    let file_path = path.to_string_lossy().to_string();
    tracing::info!("[ORA] Loading file: {:?}", path);

    // Phase 1: File open and ZIP archive initialization
    let t1 = Instant::now();
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let file_read_ms = t1.elapsed().as_secs_f64() * 1000.0;
    tracing::info!("[ORA] Phase 1 - File open: {:.1}ms", file_read_ms);

    // Clear previous cache before loading new project
    tracing::debug!("Clearing layer cache");
    clear_cache();

    // Phase 2: Parse mimetype and stack.xml
    let t2 = Instant::now();

    // 1. Verify mimetype
    {
        let mut mimetype_file = archive.by_name("mimetype")?;
        let mut mimetype = String::new();
        mimetype_file.read_to_string(&mut mimetype)?;
        if mimetype.trim() != ORA_MIMETYPE {
            return Err(FileError::InvalidFormat(format!(
                "Invalid ORA mimetype: expected '{}', got '{}'",
                ORA_MIMETYPE, mimetype
            )));
        }
    }

    // 2. Read stack.xml
    let (width, height, mut layers) = {
        let mut stack_file = archive.by_name("stack.xml")?;
        let mut stack_xml = Vec::new();
        stack_file.read_to_end(&mut stack_xml)?;

        // Parse image dimensions from stack.xml
        let mut reader = Reader::from_reader(stack_xml.as_slice());
        reader.trim_text(true);

        let mut buf = Vec::new();
        let mut width = 1920u32;
        let mut height = 1080u32;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e))
                    if e.name().as_ref() == b"image" =>
                {
                    for attr in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                        let value = String::from_utf8_lossy(&attr.value).to_string();
                        match key.as_str() {
                            "w" => width = value.parse().unwrap_or(1920),
                            "h" => height = value.parse().unwrap_or(1080),
                            _ => {}
                        }
                    }
                    break;
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(FileError::Xml(format!("XML parse error: {}", e))),
                _ => {}
            }
            buf.clear();
        }

        let layers = parse_stack_xml(&stack_xml, width, height)?;
        (width, height, layers)
    };

    let format_parse_ms = t2.elapsed().as_secs_f64() * 1000.0;
    tracing::info!("[ORA] Phase 2 - Format parse: {:.1}ms", format_parse_ms);

    // Phase 3+4: Load layer image data into cache
    let t3 = Instant::now();

    // First, collect all layer image paths
    let layer_paths: HashMap<String, String> = layers
        .iter()
        .filter_map(|l| {
            l.image_data
                .as_ref()
                .map(|path| (l.id.clone(), path.clone()))
        })
        .collect();

    // Load each layer's image data into cache (not Base64)
    for layer in &mut layers {
        if let Some(src_path) = layer_paths.get(&layer.id) {
            match archive.by_name(src_path) {
                Ok(mut img_file) => {
                    let mut img_data = Vec::new();
                    img_file.read_to_end(&mut img_data)?;

                    // Store PNG data in cache for project:// protocol
                    tracing::debug!("Caching layer: {} ({} bytes)", layer.id, img_data.len());
                    cache_layer_png(layer.id.clone(), img_data);

                    // Clear image_data - frontend will use project://layer/{id}
                    layer.image_data = None;
                }
                Err(_) => {
                    layer.image_data = None;
                    tracing::warn!("Layer image not found: {}", src_path);
                }
            }
        }
    }

    let decode_cache_ms = t3.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        "[ORA] Phase 3+4 - Decode+cache: {:.1}ms ({} layers)",
        decode_cache_ms,
        layers.len()
    );

    // 4. Load thumbnail into cache
    let thumbnail = match archive.by_name("Thumbnails/thumbnail.png") {
        Ok(mut thumb_file) => {
            let mut thumb_data = Vec::new();
            thumb_file.read_to_end(&mut thumb_data)?;
            // Store in cache for project://thumbnail
            cache_thumbnail(thumb_data, "image/png");
            // Return None - frontend will use project://thumbnail
            None
        }
        Err(_) => None,
    };

    let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        "[ORA] Total load time: {:.1}ms ({} layers)",
        total_ms,
        layers.len()
    );

    // Build benchmark data
    let benchmark = BackendBenchmark {
        session_id,
        file_path,
        format: "ora".to_string(),
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
        dpi: 72, // ORA doesn't store DPI, use default
        layers,
        flattened_image: None,
        thumbnail,
        benchmark: Some(benchmark),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_blend_mode_mapping() {
        assert_eq!(blend_mode_to_ora("normal"), "svg:src-over");
        assert_eq!(blend_mode_to_ora("multiply"), "svg:multiply");
        assert_eq!(ora_to_blend_mode("svg:src-over"), "normal");
        assert_eq!(ora_to_blend_mode("svg:multiply"), "multiply");
    }

    #[test]
    fn test_generate_stack_xml() {
        let project = ProjectData {
            width: 100,
            height: 100,
            dpi: 72,
            layers: vec![LayerData {
                id: "test_layer".to_string(),
                name: "Test Layer".to_string(),
                layer_type: "raster".to_string(),
                visible: true,
                locked: false,
                opacity: 0.8,
                blend_mode: "multiply".to_string(),
                is_background: Some(false),
                image_data: None,
                offset_x: 0,
                offset_y: 0,
            }],
            flattened_image: None,
            thumbnail: None,
            benchmark: None,
        };

        let xml = generate_stack_xml(&project).unwrap();
        let xml_str = String::from_utf8_lossy(&xml);

        assert!(xml_str.contains("w=\"100\""));
        assert!(xml_str.contains("h=\"100\""));
        assert!(xml_str.contains("name=\"Test Layer\""));
        assert!(xml_str.contains("composite-op=\"svg:multiply\""));
    }
}
