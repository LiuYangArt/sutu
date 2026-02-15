//! Compatibility adapters between legacy IPC structs and core contracts.

use crate::core::contracts::{LayerDataCore, ProjectDataCore};
use crate::file::{LayerData as LegacyLayerData, ProjectData as LegacyProjectData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

fn decode_base64_or_data_url_to_bytes(value: &str) -> Result<Vec<u8>, String> {
    let raw = if let Some(stripped) = value.strip_prefix("data:image/png;base64,") {
        stripped
    } else if value.starts_with("data:") {
        value
            .split(',')
            .nth(1)
            .ok_or_else(|| "Invalid data URL payload".to_string())?
    } else {
        value
    };

    BASE64
        .decode(raw)
        .map_err(|err| format!("Failed to decode base64 PNG: {}", err))
}

fn encode_png_bytes_as_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", BASE64.encode(bytes))
}

pub fn layer_legacy_to_core(layer: &LegacyLayerData) -> Result<LayerDataCore, String> {
    let layer_png_bytes = layer
        .image_data
        .as_deref()
        .map(decode_base64_or_data_url_to_bytes)
        .transpose()?;

    Ok(LayerDataCore {
        id: layer.id.clone(),
        name: layer.name.clone(),
        layer_type: layer.layer_type.clone(),
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        blend_mode: layer.blend_mode.clone(),
        is_background: layer.is_background,
        offset_x: layer.offset_x,
        offset_y: layer.offset_y,
        layer_png_bytes,
        legacy_image_data_base64: layer.image_data.clone(),
    })
}

pub fn layer_core_to_legacy(layer: &LayerDataCore) -> LegacyLayerData {
    let image_data = layer.legacy_image_data_base64.clone().or_else(|| {
        layer
            .layer_png_bytes
            .as_deref()
            .map(encode_png_bytes_as_data_url)
    });

    LegacyLayerData {
        id: layer.id.clone(),
        name: layer.name.clone(),
        layer_type: layer.layer_type.clone(),
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        blend_mode: layer.blend_mode.clone(),
        is_background: layer.is_background,
        image_data,
        offset_x: layer.offset_x,
        offset_y: layer.offset_y,
    }
}

pub fn project_legacy_to_core(project: &LegacyProjectData) -> Result<ProjectDataCore, String> {
    let layers = project
        .layers
        .iter()
        .map(layer_legacy_to_core)
        .collect::<Result<Vec<_>, _>>()?;

    let flattened_png_bytes = project
        .flattened_image
        .as_deref()
        .map(decode_base64_or_data_url_to_bytes)
        .transpose()?;
    let thumbnail_png_bytes = project
        .thumbnail
        .as_deref()
        .map(decode_base64_or_data_url_to_bytes)
        .transpose()?;

    Ok(ProjectDataCore {
        width: project.width,
        height: project.height,
        dpi: project.dpi,
        layers,
        flattened_png_bytes,
        thumbnail_png_bytes,
        legacy_flattened_image_base64: project.flattened_image.clone(),
        legacy_thumbnail_base64: project.thumbnail.clone(),
        benchmark: project.benchmark.clone(),
    })
}

pub fn project_core_to_legacy(project: &ProjectDataCore) -> LegacyProjectData {
    let layers = project.layers.iter().map(layer_core_to_legacy).collect();

    let flattened_image = project.legacy_flattened_image_base64.clone().or_else(|| {
        project
            .flattened_png_bytes
            .as_deref()
            .map(encode_png_bytes_as_data_url)
    });
    let thumbnail = project.legacy_thumbnail_base64.clone().or_else(|| {
        project
            .thumbnail_png_bytes
            .as_deref()
            .map(encode_png_bytes_as_data_url)
    });

    LegacyProjectData {
        width: project.width,
        height: project.height,
        dpi: project.dpi,
        layers,
        flattened_image,
        thumbnail,
        benchmark: project.benchmark.clone(),
    }
}
