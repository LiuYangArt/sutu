//! Shared file format APIs for desktop and future native adapters.

use crate::core::adapters::project_legacy_to_core;
use crate::core::contracts::ProjectDataCore;
use crate::core::errors::CoreError;
use crate::file::FileFormat;
use std::path::Path;

fn tiff_disabled_error() -> CoreError {
    CoreError::InvalidInput("TIFF format is currently disabled".to_string())
}

pub fn save_project_core(
    path: &Path,
    format: FileFormat,
    project: &ProjectDataCore,
) -> Result<(), CoreError> {
    match format {
        FileFormat::Ora => crate::file::ora::save_ora_core(path, project)?,
        FileFormat::Tiff => return Err(tiff_disabled_error()),
        FileFormat::Psd => crate::file::psd::save_psd_core(path, project)?,
    }

    Ok(())
}

pub fn load_project_core(path: &Path) -> Result<ProjectDataCore, CoreError> {
    let path_str = path.to_string_lossy().to_string();
    let format = FileFormat::from_path(&path_str).ok_or_else(|| {
        CoreError::InvalidInput(format!("Unknown file format for path: {}", path_str))
    })?;

    let legacy = match format {
        FileFormat::Ora => crate::file::ora::load_ora(path)?,
        FileFormat::Tiff => return Err(tiff_disabled_error()),
        FileFormat::Psd => crate::file::psd::load_psd(path)?,
    };

    project_legacy_to_core(&legacy).map_err(CoreError::InvalidInput)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::core::contracts::{LayerDataCore, ProjectDataCore};
    use image::{ImageBuffer, ImageFormat, Rgba};

    fn make_png_bytes(r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let img = ImageBuffer::from_pixel(1, 1, Rgba([r, g, b, a]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("png encode should succeed");
        cursor.into_inner()
    }

    fn sample_project_core() -> ProjectDataCore {
        ProjectDataCore {
            width: 1,
            height: 1,
            dpi: 72,
            layers: vec![LayerDataCore {
                id: "layer_1".to_string(),
                name: "Layer 1".to_string(),
                layer_type: "raster".to_string(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: "normal".to_string(),
                is_background: Some(true),
                offset_x: 0,
                offset_y: 0,
                layer_png_bytes: Some(make_png_bytes(255, 0, 0, 255)),
                legacy_image_data_base64: None,
            }],
            flattened_png_bytes: Some(make_png_bytes(255, 0, 0, 255)),
            thumbnail_png_bytes: Some(make_png_bytes(255, 0, 0, 255)),
            legacy_flattened_image_base64: None,
            legacy_thumbnail_base64: None,
            benchmark: None,
        }
    }

    fn temp_file_path(ext: &str) -> std::path::PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("sutu_core_roundtrip_{}.{}", ts, ext))
    }

    #[test]
    fn ora_roundtrip_keeps_document_shape() {
        let path = temp_file_path("ora");
        let project = sample_project_core();

        save_project_core(&path, FileFormat::Ora, &project).unwrap();
        let loaded = load_project_core(&path).unwrap();

        assert_eq!(loaded.width, project.width);
        assert_eq!(loaded.height, project.height);
        assert_eq!(loaded.layers.len(), project.layers.len());
        assert_eq!(loaded.layers[0].name, "Layer 1");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn psd_roundtrip_keeps_document_shape() {
        let path = temp_file_path("psd");
        let project = sample_project_core();

        save_project_core(&path, FileFormat::Psd, &project).unwrap();
        let loaded = load_project_core(&path).unwrap();

        assert_eq!(loaded.width, project.width);
        assert_eq!(loaded.height, project.height);
        assert!(!loaded.layers.is_empty());

        let _ = std::fs::remove_file(path);
    }
}
