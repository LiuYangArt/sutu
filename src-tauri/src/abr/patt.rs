//! ABR Pattern resource parser
//!
//! Parses pattern (texture) resources from ABR patt sections.
//! Based on analysis from extract_abr_patterns.rs test script.

use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};

use super::error::AbrError;

/// Pattern resource extracted from ABR file
#[derive(Debug, Clone)]
pub struct PatternResource {
    /// Pattern name (UTF-16 decoded)
    pub name: String,
    /// Pattern UUID/ID
    pub id: String,
    /// Image width in pixels
    pub width: u32,
    /// Image height in pixels
    pub height: u32,
    /// Color mode (1=Grayscale, 3=RGB, etc.)
    pub mode: u32,
    /// Raw image data (uncompressed)
    pub data: Vec<u8>,
}

impl PatternResource {
    /// Get mode name for logging
    pub fn mode_name(&self) -> &'static str {
        match self.mode {
            0 => "Bitmap",
            1 => "Grayscale",
            2 => "Indexed",
            3 => "RGB",
            4 => "CMYK",
            7 => "Multichannel",
            8 => "Duotone",
            9 => "Lab",
            _ => "Unknown",
        }
    }
}

/// Read UTF-16 BE string (4-byte length prefix = character count)
fn read_unicode_string(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
    let len = cursor.read_u32::<BigEndian>()? as usize;
    if len == 0 || len > 1000 {
        return Ok(String::new());
    }

    let mut utf16_data = Vec::with_capacity(len);
    for _ in 0..len {
        utf16_data.push(cursor.read_u16::<BigEndian>()?);
    }

    String::from_utf16(&utf16_data).map_err(|e| AbrError::StringDecode(e.to_string()))
}

/// Read Pascal string (1-byte length prefix + ASCII)
fn read_pascal_string(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
    let len = cursor.read_u8()? as usize;
    if len == 0 || len > 100 {
        return Ok(String::new());
    }
    let mut bytes = vec![0u8; len];
    cursor.read_exact(&mut bytes)?;
    // Align to 2-byte boundary
    if len % 2 == 0 {
        cursor.seek(SeekFrom::Current(1)).ok();
    }
    String::from_utf8(bytes).map_err(|e| AbrError::StringDecode(e.to_string()))
}

/// Parse a single pattern from data
///
/// Pattern format (from hex dump analysis):
/// - 4 bytes: pattern total size (includes this field)
/// - 4 bytes: version (1)
/// - 4 bytes: color mode
/// - 2 bytes: width
/// - 2 bytes: height
/// - 4 bytes: name length (UTF-16 characters)
/// - N*2 bytes: name (UTF-16 BE)
/// - Pascal string: ID/UUID
/// - Padding to 4-byte boundary
/// - Image data
fn parse_pattern(data: &[u8]) -> Result<(PatternResource, usize), AbrError> {
    if data.len() < 30 {
        return Err(AbrError::InvalidFile("Pattern data too short".into()));
    }

    // Read pattern total size
    let pattern_size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;

    if !(40..=5_000_000).contains(&pattern_size) {
        return Err(AbrError::InvalidFile(format!(
            "Invalid pattern size: {}",
            pattern_size
        )));
    }

    if pattern_size > data.len() {
        return Err(AbrError::InvalidFile(format!(
            "Pattern size {} exceeds available data {}",
            pattern_size,
            data.len()
        )));
    }

    let pattern_data = &data[4..pattern_size];
    let mut cursor = Cursor::new(pattern_data);

    // Version (4 bytes)
    let version = cursor.read_u32::<BigEndian>()?;
    if version != 1 {
        return Err(AbrError::InvalidFile(format!(
            "Unsupported pattern version: {}",
            version
        )));
    }

    // Mode (4 bytes)
    let mode = cursor.read_u32::<BigEndian>()?;
    if mode > 10 {
        return Err(AbrError::InvalidFile(format!("Invalid mode: {}", mode)));
    }

    // Width (2 bytes)
    let width = cursor.read_u16::<BigEndian>()? as u32;

    // Height (2 bytes)
    let height = cursor.read_u16::<BigEndian>()? as u32;

    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(AbrError::InvalidFile(format!(
            "Invalid dimensions: {}x{}",
            width, height
        )));
    }

    // Name (UTF-16 BE string)
    let name = read_unicode_string(&mut cursor)?;
    if name.is_empty() {
        return Err(AbrError::InvalidFile("Empty pattern name".into()));
    }

    // ID (Pascal string)
    let id = read_pascal_string(&mut cursor).unwrap_or_default();

    // Align to 4-byte boundary
    let pos = cursor.position();
    let padding = (4 - (pos % 4)) % 4;
    cursor.seek(SeekFrom::Current(padding as i64)).ok();

    // Read remaining image data
    let data_start = cursor.position() as usize;
    let image_data = pattern_data[data_start..].to_vec();

    let resource = PatternResource {
        name,
        id,
        width,
        height,
        mode,
        data: image_data,
    };

    // 4-byte aligned total size
    let aligned_size = (pattern_size + 3) & !3;

    Ok((resource, aligned_size))
}

/// Parse all patterns from a patt section
pub fn parse_patt_section(data: &[u8]) -> Result<Vec<PatternResource>, AbrError> {
    let mut patterns = Vec::new();
    let mut offset: usize = 0;

    tracing::debug!("Parsing patt section: {} bytes", data.len());

    while offset + 30 <= data.len() {
        // Quick check: read size field
        if offset + 4 > data.len() {
            break;
        }
        let size = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;

        // Validate size
        if !(40..=2_000_000).contains(&size) || offset + size > data.len() {
            offset += 1;
            continue;
        }

        // Try to parse
        match parse_pattern(&data[offset..]) {
            Ok((pattern, consumed)) => {
                tracing::debug!(
                    "Parsed pattern: '{}' ({}x{}, {})",
                    pattern.name,
                    pattern.width,
                    pattern.height,
                    pattern.mode_name()
                );
                patterns.push(pattern);
                offset += consumed;
            }
            Err(_) => {
                offset += 1;
            }
        }

        // Safety limit
        if patterns.len() > 500 {
            tracing::warn!("Reached max pattern count (500), stopping");
            break;
        }
    }

    tracing::info!("Parsed {} patterns from patt section", patterns.len());
    Ok(patterns)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_liuyang_patterns() {
        // Test with actual ABR file
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/liuyang_paintbrushes.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");

        // Find patt section
        let patt_data = find_patt_section(&data);
        assert!(patt_data.is_some(), "Should find patt section");

        let patt_data = patt_data.unwrap();
        let patterns = parse_patt_section(&patt_data).expect("Should parse patterns");

        println!("Found {} patterns:", patterns.len());
        for (i, p) in patterns.iter().enumerate() {
            println!(
                "  {}: '{}' ({}x{}, {})",
                i + 1,
                p.name,
                p.width,
                p.height,
                p.mode_name()
            );
        }

        assert!(!patterns.is_empty(), "Should have at least one pattern");
    }

    /// Helper to find patt section in ABR data (for testing)
    fn find_patt_section(data: &[u8]) -> Option<Vec<u8>> {
        let mut cursor = Cursor::new(data);
        let data_len = data.len() as u64;

        while cursor.position() + 12 <= data_len {
            let pos = cursor.position();
            let mut signature = [0u8; 4];
            if cursor.read_exact(&mut signature).is_err() {
                break;
            }

            if &signature != b"8BIM" {
                cursor.seek(SeekFrom::Start(pos + 1)).ok();
                continue;
            }

            let mut tag = [0u8; 4];
            cursor.read_exact(&mut tag).ok()?;
            let tag_str = std::str::from_utf8(&tag).unwrap_or("????");

            let section_size = cursor.read_u32::<BigEndian>().ok()? as usize;

            if tag_str == "patt" {
                let mut section_data = vec![0u8; section_size];
                cursor.read_exact(&mut section_data).ok()?;
                return Some(section_data);
            } else {
                cursor.seek(SeekFrom::Current(section_size as i64)).ok();
                if section_size % 2 != 0 {
                    cursor.seek(SeekFrom::Current(1)).ok();
                }
            }
        }

        None
    }
}
