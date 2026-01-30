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

/// VMA header size in bytes
const VMA_HEADER_SIZE: usize = 31;

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

    /// Decode the raw pattern data into RGBA pixel buffer
    ///
    /// The pattern data contains VMA (Virtual Memory Array) structured channels.
    /// Each channel has a 31-byte header followed by uncompressed or RLE data.
    ///
    /// Note: The actual dimensions may differ from pattern metadata due to VMA structure.
    /// Use `decode_image_with_dimensions()` if you need the actual dimensions.
    pub fn decode_image(&self) -> Option<Vec<u8>> {
        self.decode_image_with_dimensions().map(|(rgba, _, _)| rgba)
    }

    /// Decode the raw pattern data into RGBA pixel buffer with actual dimensions
    ///
    /// Returns (rgba_data, actual_width, actual_height) tuple.
    /// The actual dimensions come from the VMA structure and may differ from pattern metadata.
    pub fn decode_image_with_dimensions(&self) -> Option<(Vec<u8>, u32, u32)> {
        let n_channels = if self.mode == 3 { 3 } else { 1 };

        // Search for VMA header
        let vma_info = self.find_vma_header()?;
        let (vma_offset, actual_width, actual_height) = vma_info;

        // Decode each channel
        let mut channels: Vec<Vec<u8>> = Vec::with_capacity(n_channels);
        let mut offset = vma_offset;
        let channel_pixels = actual_width * actual_height;

        for _ in 0..n_channels {
            if offset + VMA_HEADER_SIZE > self.data.len() {
                tracing::warn!("Not enough data for channel");
                return None;
            }

            let d = &self.data[offset..];
            let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]) as usize;
            let compression = d[30];

            let data_start = offset + VMA_HEADER_SIZE;
            let chan_data = if compression == 0 {
                // Uncompressed
                let data_end = data_start + channel_pixels;
                if data_end > self.data.len() {
                    return None;
                }
                self.data[data_start..data_end].to_vec()
            } else {
                // RLE compressed
                self.decode_rle_channel(data_start, actual_width, actual_height)?
            };

            if chan_data.len() != channel_pixels {
                tracing::warn!(
                    "Channel size mismatch: {} vs expected {}",
                    chan_data.len(),
                    channel_pixels
                );
                return None;
            }

            channels.push(chan_data);
            offset += 8 + size;
        }

        // Convert to RGBA using actual dimensions from VMA
        let mut rgba = Vec::with_capacity(channel_pixels * 4);

        if n_channels == 3 {
            // RGB -> RGBA
            for ((r, g), b) in channels[0]
                .iter()
                .zip(channels[1].iter())
                .zip(channels[2].iter())
            {
                rgba.push(*r);
                rgba.push(*g);
                rgba.push(*b);
                rgba.push(255);
            }
        } else {
            // Grayscale -> RGBA
            for &gray in &channels[0] {
                rgba.push(gray);
                rgba.push(gray);
                rgba.push(gray);
                rgba.push(255);
            }
        }

        Some((rgba, actual_width as u32, actual_height as u32))
    }

    /// Find VMA header in pattern data
    fn find_vma_header(&self) -> Option<(usize, usize, usize)> {
        let width = self.width as usize;
        let height = self.height as usize;

        for test_offset in 0..1000 {
            if test_offset + VMA_HEADER_SIZE > self.data.len() {
                break;
            }

            let d = &self.data[test_offset..];

            let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
            let depth = i16::from_be_bytes([d[28], d[29]]);
            let compression = d[30];

            // Use checked_sub to prevent overflow
            let Some(h_diff) = bottom.checked_sub(top) else {
                continue;
            };
            let Some(w_diff) = right.checked_sub(left) else {
                continue;
            };

            if h_diff <= 0 || w_diff <= 0 {
                continue;
            }

            let vma_height = h_diff as usize;
            let vma_width = w_diff as usize;

            // Allow swapped dimensions
            let dims_match = (vma_height == height && vma_width == width)
                || (vma_height == width && vma_width == height);

            if (0..=10).contains(&version)
                && size > 0
                && size < 10_000_000
                && dims_match
                && depth == 8
                && compression <= 1
            {
                return Some((test_offset, vma_width, vma_height));
            }
        }

        None
    }

    /// Decode RLE compressed channel data (PackBits algorithm)
    fn decode_rle_channel(
        &self,
        row_table_offset: usize,
        width: usize,
        height: usize,
    ) -> Option<Vec<u8>> {
        let row_table_size = height * 2;
        let row_table_end = row_table_offset + row_table_size;
        if row_table_end > self.data.len() {
            return None;
        }

        // Read row lengths from table
        let row_lengths: Vec<usize> = (0..height)
            .map(|i| {
                let idx = row_table_offset + i * 2;
                u16::from_be_bytes([self.data[idx], self.data[idx + 1]]) as usize
            })
            .collect();

        let mut decoded = Vec::with_capacity(width * height);
        let mut pos = row_table_end;

        for &comp_len in &row_lengths {
            if pos + comp_len > self.data.len() {
                return None;
            }

            let row = self.decode_packbits_row(&self.data[pos..pos + comp_len], width);
            decoded.extend(row);
            pos += comp_len;
        }

        (decoded.len() == width * height).then_some(decoded)
    }

    /// Decode a single row using PackBits algorithm
    fn decode_packbits_row(&self, input: &[u8], width: usize) -> Vec<u8> {
        let mut row = Vec::with_capacity(width);
        let mut i = 0;

        while i < input.len() && row.len() < width {
            let b = input[i] as i8;
            i += 1;

            match b {
                -128 => {} // No-op
                0..=127 => {
                    // Copy next n+1 bytes literally
                    let count = (b as usize) + 1;
                    let available = count.min(input.len().saturating_sub(i));
                    let to_copy = available.min(width - row.len());
                    row.extend_from_slice(&input[i..i + to_copy]);
                    i += count;
                }
                _ => {
                    // Repeat next byte (-n + 1) times
                    let count = ((-b) as usize) + 1;
                    if i < input.len() {
                        let val = input[i];
                        i += 1;
                        let to_repeat = count.min(width - row.len());
                        row.resize(row.len() + to_repeat, val);
                    }
                }
            }
        }

        // Pad row if needed
        row.resize(width, 0);
        row
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

    // Max size: 20MB to support large textures like 2048x1536 RGB
    if !(40..=20_000_000).contains(&pattern_size) {
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

        let is_valid_size = (40..=50_000_000).contains(&size);
        let exceeds_data = offset + size > data.len();

        if !is_valid_size || exceeds_data {
            if offset % 1_000_000 == 0 {
                tracing::debug!(
                    "Skipping invalid pattern at offset {} (Size: {}, ValidSize: {}, Fits: {})",
                    offset,
                    size,
                    is_valid_size,
                    !exceeds_data
                );
            }
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
            Err(e) => {
                tracing::debug!("Failed to parse pattern at offset {}: {}", offset, e);
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

    #[test]
    fn test_decode_pattern_images() {
        // Test decode_image for all patterns
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/liuyang_paintbrushes.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");
        let patt_data = find_patt_section(&data).expect("Should find patt section");
        let patterns = parse_patt_section(&patt_data).expect("Should parse patterns");

        println!("Testing decode_image for {} patterns:", patterns.len());

        let mut success_count = 0;
        for (i, p) in patterns.iter().enumerate() {
            let result = p.decode_image();
            let expected_size = (p.width * p.height * 4) as usize;

            match result {
                Some(rgba) if rgba.len() == expected_size => {
                    println!(
                        "  ✓ Pattern {}: '{}' ({}x{} {})",
                        i,
                        p.name,
                        p.width,
                        p.height,
                        p.mode_name()
                    );
                    success_count += 1;
                }
                Some(rgba) => {
                    println!(
                        "  ? Pattern {}: '{}' size mismatch: {} != {}",
                        i,
                        p.name,
                        rgba.len(),
                        expected_size
                    );
                }
                None => {
                    println!("  ✗ Pattern {}: '{}' failed to decode", i, p.name);
                }
            }
        }

        println!(
            "\n{}/{} patterns decoded successfully",
            success_count,
            patterns.len()
        );
        assert!(
            success_count == patterns.len(),
            "All patterns should decode successfully"
        );
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
