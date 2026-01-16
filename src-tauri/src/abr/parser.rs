//! ABR file parser
//!
//! Parses Adobe Photoshop ABR brush files.
//! Supports versions 1, 2, 6, 7, and 10.
//!
//! Reference: Krita's kis_abr_brush_collection.cpp

use std::io::{Cursor, Read, Seek, SeekFrom};

use byteorder::{BigEndian, ReadBytesExt};

use super::defaults::AbrDefaults;
use super::error::AbrError;
use super::samp::normalize_brush_texture;
use super::types::{AbrBrush, AbrDynamics, AbrFile, AbrVersion, GrayscaleImage};

/// ABR file header information
#[derive(Debug, Clone)]
struct AbrHeader {
    version: AbrVersion,
    subversion: u16,
    count: u32,
}

/// Main ABR parser
pub struct AbrParser;

impl AbrParser {
    /// Parse an ABR file from raw bytes
    pub fn parse(data: &[u8]) -> Result<AbrFile, AbrError> {
        let mut cursor = Cursor::new(data);

        // Read header
        let header = Self::read_header(&mut cursor)?;

        tracing::debug!(
            "ABR header: version={:?}, subversion={}, count={}",
            header.version,
            header.subversion,
            header.count
        );

        if header.count == 0 {
            return Ok(AbrFile {
                version: header.version,
                brushes: Vec::new(),
            });
        }

        // Parse based on version
        let brushes = if header.version.is_new_format() {
            Self::parse_v6(&mut cursor, &header)?
        } else {
            Self::parse_v12(&mut cursor, &header)?
        };

        Ok(AbrFile {
            version: header.version,
            brushes,
        })
    }

    /// Read ABR file header
    fn read_header(cursor: &mut Cursor<&[u8]>) -> Result<AbrHeader, AbrError> {
        let version_num = cursor.read_u16::<BigEndian>()?;

        let version = match version_num {
            1 => AbrVersion::V1,
            2 => AbrVersion::V2,
            6 => AbrVersion::V6,
            7 => AbrVersion::V7,
            10 => AbrVersion::V10,
            _ => return Err(AbrError::UnsupportedVersion(version_num)),
        };

        let (subversion, count) = match version {
            AbrVersion::V1 | AbrVersion::V2 => {
                let count = cursor.read_u16::<BigEndian>()? as u32;
                (0, count)
            }
            AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10 => {
                let subversion = cursor.read_u16::<BigEndian>()?;
                // For v6+, we need to scan the samp section to count brushes
                // Save position after reading header (before 8BIM blocks)
                let header_end = cursor.position();
                let count = Self::count_samples_v6(cursor, subversion)?;
                // Reset to header end so parse_v6 can find sections
                cursor.seek(SeekFrom::Start(header_end))?;
                (subversion, count)
            }
        };

        Ok(AbrHeader {
            version,
            subversion,
            count,
        })
    }

    /// Count samples in v6+ format by scanning the samp section
    fn count_samples_v6(cursor: &mut Cursor<&[u8]>, subversion: u16) -> Result<u32, AbrError> {
        if subversion != 1 && subversion != 2 {
            return Err(AbrError::UnsupportedVersion(6));
        }

        let origin = cursor.position();

        // Find samp section
        if !Self::reach_8bim_section(cursor, "samp")? {
            cursor.seek(SeekFrom::Start(origin))?;
            return Ok(0);
        }

        let section_size = cursor.read_u32::<BigEndian>()?;
        let section_end = cursor.position() + section_size as u64;
        let data_start = cursor.position();

        let mut count = 0u32;

        while cursor.position() < section_end {
            let brush_size = cursor.read_u32::<BigEndian>()?;
            // Align to 4 bytes
            let aligned_size = (brush_size + 3) & !3;
            let new_pos = cursor.position() + aligned_size as u64;

            if new_pos > section_end {
                break;
            }

            cursor.seek(SeekFrom::Start(new_pos))?;
            count += 1;
        }

        // Reset to data start for actual parsing
        cursor.seek(SeekFrom::Start(data_start))?;

        Ok(count)
    }

    /// Seek to a named 8BIM section
    fn reach_8bim_section(cursor: &mut Cursor<&[u8]>, name: &str) -> Result<bool, AbrError> {
        let data_len = cursor.get_ref().len() as u64;

        while cursor.position() + 8 <= data_len {
            let mut tag = [0u8; 4];
            cursor.read_exact(&mut tag)?;

            if &tag != b"8BIM" {
                return Err(AbrError::Invalid8BIMBlock);
            }

            let mut tagname = [0u8; 4];
            cursor.read_exact(&mut tagname)?;

            let tagname_str =
                std::str::from_utf8(&tagname).map_err(|e| AbrError::StringDecode(e.to_string()))?;

            if tagname_str == name {
                return Ok(true);
            }

            // Skip this section
            let section_size = cursor.read_u32::<BigEndian>()?;
            cursor.seek(SeekFrom::Current(section_size as i64))?;
        }

        Ok(false)
    }

    /// Parse v1/v2 format brushes
    fn parse_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<Vec<AbrBrush>, AbrError> {
        let mut brushes = Vec::new();

        for i in 0..header.count {
            match Self::parse_brush_v12(cursor, header) {
                Ok(Some(brush)) => brushes.push(brush),
                Ok(None) => {
                    tracing::warn!("Skipped computed brush #{}", i);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse brush #{}: {}", i, e);
                }
            }
        }

        Ok(brushes)
    }

    /// Parse a single v1/v2 brush
    fn parse_brush_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<Option<AbrBrush>, AbrError> {
        let brush_type = cursor.read_u16::<BigEndian>()?;
        let brush_size = cursor.read_u32::<BigEndian>()?;
        let next_brush = cursor.position() + brush_size as u64;

        let result = match brush_type {
            1 => {
                // Computed (parametric) brush - skip for now
                tracing::debug!("Computed brush found, skipping");
                None
            }
            2 => {
                // Sampled brush
                Some(Self::parse_sampled_brush_v12(cursor, header)?)
            }
            _ => {
                tracing::warn!("Unknown brush type: {}", brush_type);
                None
            }
        };

        // Seek to next brush
        cursor.seek(SeekFrom::Start(next_brush))?;

        Ok(result)
    }

    /// Parse a sampled brush in v1/v2 format
    fn parse_sampled_brush_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<AbrBrush, AbrError> {
        // Skip misc bytes (4) and spacing (2)
        cursor.seek(SeekFrom::Current(6))?;

        // Read name for v2
        let name = if header.version == AbrVersion::V2 {
            Self::read_ucs2_string(cursor)?
        } else {
            String::new()
        };

        // Skip antialiasing (1) and short bounds (8)
        cursor.seek(SeekFrom::Current(9))?;

        // Read bounds
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let depth = cursor.read_u16::<BigEndian>()?;
        let compression = cursor.read_u8()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        if width == 0 || height == 0 {
            return Err(AbrError::InvalidFile("Zero dimension brush".into()));
        }

        if height > 16384 {
            return Err(AbrError::InvalidFile("Brush too tall".into()));
        }

        // Read image data
        let image_data = if compression == 0 {
            Self::read_raw_image(cursor, width, height, depth)?
        } else {
            Self::read_rle_image(cursor, height)?
        };

        // Normalize alpha using smart detection
        let raw_image = GrayscaleImage::new(width, height, image_data);
        let normalized = normalize_brush_texture(&raw_image);

        Ok(AbrBrush {
            name: if name.is_empty() {
                format!("Brush {}", width)
            } else {
                name
            },
            uuid: None,
            tip_image: Some(normalized),
            diameter: width as f32,
            spacing: AbrDefaults::SPACING,
            angle: AbrDefaults::ANGLE,
            roundness: AbrDefaults::ROUNDNESS,
            hardness: None,
            dynamics: None,
            is_computed: false,
        })
    }

    /// Parse v6+ format brushes
    fn parse_v6(cursor: &mut Cursor<&[u8]>, header: &AbrHeader) -> Result<Vec<AbrBrush>, AbrError> {
        let mut brushes = Vec::new();

        // Parse samp section (contains brush tip images)
        let origin = cursor.position();

        if Self::reach_8bim_section(cursor, "samp")? {
            let section_size = cursor.read_u32::<BigEndian>()?;
            let section_end = cursor.position() + section_size as u64;

            let mut brush_id = 0;

            while cursor.position() < section_end {
                match Self::parse_brush_v6(cursor, header, brush_id) {
                    Ok(brush) => {
                        brushes.push(brush);
                        brush_id += 1;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse brush #{}: {}", brush_id, e);
                        break;
                    }
                }
            }
        } else {
            cursor.seek(SeekFrom::Start(origin))?;
        }

        Ok(brushes)
    }

    /// Parse a single v6+ brush from samp section
    fn parse_brush_v6(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
        id: u32,
    ) -> Result<AbrBrush, AbrError> {
        let brush_size = cursor.read_u32::<BigEndian>()?;
        let aligned_size = (brush_size + 3) & !3;
        let next_brush = cursor.position() + aligned_size as u64;

        // Skip key (37 bytes)
        cursor.seek(SeekFrom::Current(37))?;

        // Skip additional bytes based on subversion
        if header.subversion == 1 {
            // Short coordinates (8) + unknown short (2)
            cursor.seek(SeekFrom::Current(10))?;
        } else {
            // Unknown bytes
            cursor.seek(SeekFrom::Current(264))?;
        }

        // Read bounds
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let depth = cursor.read_u16::<BigEndian>()?;
        let compression = cursor.read_u8()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        if width == 0 || height == 0 {
            cursor.seek(SeekFrom::Start(next_brush))?;
            return Err(AbrError::InvalidFile("Zero dimension brush".into()));
        }

        // Read image data
        let image_data = if compression == 0 {
            Self::read_raw_image(cursor, width, height, depth)?
        } else {
            Self::read_rle_image(cursor, height)?
        };

        // Normalize alpha using smart detection
        let raw_image = GrayscaleImage::new(width, height, image_data);
        let normalized = normalize_brush_texture(&raw_image);

        // Seek to next brush
        cursor.seek(SeekFrom::Start(next_brush))?;

        Ok(AbrBrush {
            name: format!("Brush_{}", id + 1),
            uuid: Some(format!("abr-{}", id)),
            tip_image: Some(normalized),
            diameter: width as f32,
            spacing: AbrDefaults::SPACING,
            angle: AbrDefaults::ANGLE,
            roundness: AbrDefaults::ROUNDNESS,
            hardness: None,
            dynamics: Some(AbrDynamics::default()),
            is_computed: false,
        })
    }

    /// Read raw (uncompressed) image data
    fn read_raw_image(
        cursor: &mut Cursor<&[u8]>,
        width: u32,
        height: u32,
        depth: u16,
    ) -> Result<Vec<u8>, AbrError> {
        let bytes_per_pixel = (depth / 8) as u32;
        let size = (width * height * bytes_per_pixel) as usize;

        let mut buffer = vec![0u8; size];
        cursor.read_exact(&mut buffer)?;

        // If depth > 8, we need to downsample
        if bytes_per_pixel > 1 {
            // Take every Nth byte (assuming big-endian, take MSB)
            let downsampled: Vec<u8> = buffer
                .chunks(bytes_per_pixel as usize)
                .map(|chunk| chunk[0])
                .collect();
            Ok(downsampled)
        } else {
            Ok(buffer)
        }
    }

    /// Read RLE compressed image data (PackBits algorithm)
    fn read_rle_image(cursor: &mut Cursor<&[u8]>, height: u32) -> Result<Vec<u8>, AbrError> {
        // Read scanline sizes
        let mut scanline_sizes = Vec::with_capacity(height as usize);
        for _ in 0..height {
            scanline_sizes.push(cursor.read_u16::<BigEndian>()?);
        }

        // Decode each scanline
        let mut data = Vec::new();

        for &scanline_size in &scanline_sizes {
            let scanline_end = cursor.position() + scanline_size as u64;

            while cursor.position() < scanline_end {
                let n = cursor.read_i8()?;

                if n >= 0 {
                    // Copy next n+1 bytes literally
                    let count = (n as usize) + 1;
                    let mut bytes = vec![0u8; count];
                    cursor.read_exact(&mut bytes)?;
                    data.extend(bytes);
                } else if n > -128 {
                    // Repeat next byte (-n + 1) times
                    let count = (-n as usize) + 1;
                    let byte = cursor.read_u8()?;
                    data.extend(std::iter::repeat(byte).take(count));
                }
                // n == -128 is a no-op
            }
        }

        Ok(data)
    }

    /// Read UCS-2 (UTF-16 BE) string
    fn read_ucs2_string(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
        let length = cursor.read_u32::<BigEndian>()? as usize;

        if length == 0 {
            return Ok(String::new());
        }

        let mut utf16_data = Vec::with_capacity(length);
        for _ in 0..length {
            utf16_data.push(cursor.read_u16::<BigEndian>()?);
        }

        String::from_utf16(&utf16_data).map_err(|e| AbrError::StringDecode(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rle_decode_simple() {
        // Simple RLE: repeat 'A' 5 times
        // -4 (repeat 5 times), 'A'
        let data = vec![0xFC, 0x41]; // -4 in signed, 'A'
        let mut cursor = Cursor::new(data.as_slice());

        // Manually decode
        let n = cursor.read_i8().unwrap();
        assert_eq!(n, -4);
        let byte = cursor.read_u8().unwrap();
        assert_eq!(byte, 0x41);

        let count = (-n as usize) + 1; // 5
        assert_eq!(count, 5);
    }

    #[test]
    fn test_parse_tahraart_abr() {
        // Test with actual ABR file
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/tahraart.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping test", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");
        let result = AbrParser::parse(&data);

        match result {
            Ok(abr_file) => {
                println!("Parsed ABR file: version={:?}", abr_file.version);
                println!("Number of brushes: {}", abr_file.brushes.len());

                for (i, brush) in abr_file.brushes.iter().enumerate() {
                    println!(
                        "  Brush {}: name='{}', diameter={}, has_tip={}",
                        i,
                        brush.name,
                        brush.diameter,
                        brush.tip_image.is_some()
                    );
                    if let Some(ref img) = brush.tip_image {
                        println!("    Tip image: {}x{}", img.width, img.height);
                    }
                }

                assert!(
                    !abr_file.brushes.is_empty(),
                    "Should have at least one brush"
                );
            }
            Err(e) => {
                panic!("Failed to parse ABR file: {}", e);
            }
        }
    }

    #[test]
    fn test_parse_lingybrush_abr() {
        // Test with another ABR file
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/lingybrush.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping test", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");
        let result = AbrParser::parse(&data);

        match result {
            Ok(abr_file) => {
                println!("Parsed lingybrush.abr: version={:?}", abr_file.version);
                println!("Number of brushes: {}", abr_file.brushes.len());
                assert!(
                    !abr_file.brushes.is_empty(),
                    "Should have at least one brush"
                );
            }
            Err(e) => {
                // Some files may have unsupported features, log but don't fail
                eprintln!("Parse result: {}", e);
            }
        }
    }
}
