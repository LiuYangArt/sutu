//! .pat file parser
//!
//! Parses standalone Photoshop Pattern (.pat) files.
//! Based on reverse engineering documented in postmortem/2026-01-30-pat-file-decoding.md

use byteorder::{BigEndian, ReadBytesExt};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use super::types::{PatternMode, PatternResource};

/// Error type for .pat parsing
#[derive(Debug)]
pub enum PatError {
    Io(std::io::Error),
    InvalidFile(String),
    UnsupportedVersion(u16),
    Utf16Error(String),
}

impl std::fmt::Display for PatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "IO error: {}", e),
            Self::InvalidFile(s) => write!(f, "Invalid file: {}", s),
            Self::UnsupportedVersion(v) => write!(f, "Unsupported version: {}", v),
            Self::Utf16Error(s) => write!(f, "UTF-16 decode error: {}", s),
        }
    }
}

impl std::error::Error for PatError {}

impl From<std::io::Error> for PatError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Parsed pattern with raw image data
#[derive(Debug)]
pub struct ParsedPattern {
    /// Pattern name
    pub name: String,
    /// Pattern UUID/ID
    pub id: String,
    /// Image width
    pub width: u32,
    /// Image height
    pub height: u32,
    /// Color mode
    pub mode: PatternMode,
    /// Decoded RGBA image data
    pub rgba_data: Vec<u8>,
}

impl ParsedPattern {
    /// Convert to PatternResource with content hash
    pub fn into_resource(self, source: &str, group: Option<String>) -> PatternResource {
        // Calculate content hash from RGBA data
        let mut hasher = Sha256::new();
        hasher.update(&self.rgba_data);
        let hash = hasher.finalize();
        let content_hash = hex::encode(hash);

        // Use content hash as ID if original ID is empty
        let id = if self.id.is_empty() {
            content_hash[..16].to_string()
        } else {
            self.id
        };

        PatternResource {
            id,
            name: self.name,
            content_hash,
            width: self.width,
            height: self.height,
            mode: self.mode,
            source: source.to_string(),
            group,
        }
    }

    /// Get raw RGBA data
    pub fn rgba(&self) -> &[u8] {
        &self.rgba_data
    }
}

/// Parse a .pat file and return all patterns
pub fn parse_pat_file(path: &Path) -> Result<Vec<ParsedPattern>, PatError> {
    let data = std::fs::read(path)?;
    parse_pat_data(&data)
}

/// Parse .pat data from bytes
pub fn parse_pat_data(data: &[u8]) -> Result<Vec<ParsedPattern>, PatError> {
    let mut cursor = Cursor::new(data);

    // File header: 8BPT signature
    let mut signature = [0u8; 4];
    cursor.read_exact(&mut signature)?;
    if &signature != b"8BPT" {
        return Err(PatError::InvalidFile(format!(
            "Invalid signature: {:?}",
            signature
        )));
    }

    // Version (2 bytes)
    let version = cursor.read_u16::<BigEndian>()?;
    if version != 1 {
        return Err(PatError::UnsupportedVersion(version));
    }

    // Pattern count (4 bytes)
    let count = cursor.read_u32::<BigEndian>()?;
    tracing::debug!("PAT file: version={}, count={}", version, count);

    let mut patterns = Vec::with_capacity(count as usize);

    for i in 0..count {
        match parse_single_pattern(&mut cursor, data.len() as u64) {
            Ok(pattern) => {
                tracing::debug!(
                    "Parsed pattern {}/{}: '{}' ({}x{}, {:?})",
                    i + 1,
                    count,
                    pattern.name,
                    pattern.width,
                    pattern.height,
                    pattern.mode
                );
                patterns.push(pattern);
            }
            Err(e) => {
                tracing::warn!("Failed to parse pattern {}/{}: {}", i + 1, count, e);
                // Try to recover by scanning for next valid pattern header
                if !try_sync_to_next_pattern(&mut cursor, data.len() as u64) {
                    break;
                }
            }
        }
    }

    tracing::info!("Parsed {} patterns from .pat file", patterns.len());
    Ok(patterns)
}

/// Parse a single pattern from cursor
fn parse_single_pattern(
    cursor: &mut Cursor<&[u8]>,
    data_len: u64,
) -> Result<ParsedPattern, PatError> {
    let scan_limit = cursor.position() + 100000;

    // Scan for pattern header (version=1, mode<50, valid dimensions)
    while cursor.position() < scan_limit && cursor.position() + 16 < data_len {
        let attempt_pos = cursor.position();

        let ver = cursor.read_u32::<BigEndian>()?;
        if ver != 1 {
            cursor.seek(SeekFrom::Start(attempt_pos + 1))?;
            continue;
        }

        let mode = cursor.read_u32::<BigEndian>()?;
        if mode >= 50 {
            cursor.seek(SeekFrom::Start(attempt_pos + 1))?;
            continue;
        }

        let height = cursor.read_u16::<BigEndian>()? as u32;
        let width = cursor.read_u16::<BigEndian>()? as u32;

        if height == 0 || width == 0 || height > 8192 || width > 8192 {
            cursor.seek(SeekFrom::Start(attempt_pos + 1))?;
            continue;
        }

        // Found valid header, rewind and parse
        cursor.seek(SeekFrom::Start(attempt_pos))?;
        return parse_pattern_at_position(cursor, data_len);
    }

    Err(PatError::InvalidFile(
        "Could not find pattern header".into(),
    ))
}

/// Parse pattern at current cursor position
fn parse_pattern_at_position(
    cursor: &mut Cursor<&[u8]>,
    data_len: u64,
) -> Result<ParsedPattern, PatError> {
    let _version = cursor.read_u32::<BigEndian>()?;
    let mode_num = cursor.read_u32::<BigEndian>()?;
    let height = cursor.read_u16::<BigEndian>()? as u32;
    let width = cursor.read_u16::<BigEndian>()? as u32;

    let mode = PatternMode::from_ps_mode(mode_num)
        .ok_or_else(|| PatError::InvalidFile(format!("Unsupported mode: {}", mode_num)))?;

    // Name (UTF-16BE, 4-byte length prefix)
    let name_len = cursor.read_u32::<BigEndian>()? as usize;
    let name = if name_len > 0 && name_len < 1000 {
        let mut utf16 = Vec::with_capacity(name_len);
        for _ in 0..name_len {
            utf16.push(cursor.read_u16::<BigEndian>()?);
        }
        // Remove trailing null if present
        if utf16.last() == Some(&0) {
            utf16.pop();
        }
        String::from_utf16(&utf16).map_err(|e| PatError::Utf16Error(e.to_string()))?
    } else {
        String::new()
    };

    // ID (1-byte length prefix, ASCII)
    let id_len = cursor.read_u8()? as usize;
    let id = if id_len > 0 && id_len < 100 {
        let mut id_bytes = vec![0u8; id_len];
        cursor.read_exact(&mut id_bytes)?;
        String::from_utf8(id_bytes).unwrap_or_default()
    } else {
        String::new()
    };

    // Decode image data
    let rgba_data = decode_pattern_image(cursor, width, height, mode, data_len)?;

    Ok(ParsedPattern {
        name,
        id,
        width,
        height,
        mode,
        rgba_data,
    })
}

/// Decode pattern image data from VMA structure
fn decode_pattern_image(
    cursor: &mut Cursor<&[u8]>,
    width: u32,
    height: u32,
    mode: PatternMode,
    data_len: u64,
) -> Result<Vec<u8>, PatError> {
    let data = cursor.get_ref();
    let search_start = cursor.position() as usize;

    // Search for VMA header in next 2000 bytes
    let search_end = (search_start + 2000).min(data.len());
    let search_buf = &data[search_start..search_end];

    let vma_offset = find_vma_header(search_buf, width as usize, height as usize)
        .ok_or_else(|| PatError::InvalidFile("VMA header not found".into()))?;

    cursor.seek(SeekFrom::Start((search_start + vma_offset) as u64))?;

    let n_channels = mode.channels();
    let channel_pixels = (width * height) as usize;
    let mut channels: Vec<Vec<u8>> = Vec::with_capacity(n_channels);

    for _ in 0..n_channels {
        let channel_start = cursor.position();
        if channel_start + 32 > data_len {
            return Err(PatError::InvalidFile(
                "Not enough data for VMA header".into(),
            ));
        }

        let mut header = [0u8; 32];
        cursor.read_exact(&mut header)?;

        let size = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let compression = header[30];

        // Seek back to data start (header is 31 bytes, we read 32)
        cursor.seek(SeekFrom::Start(channel_start + 31))?;

        let channel_data = if compression == 0 {
            // Uncompressed
            let data_len = size.saturating_sub(23);
            if data_len >= channel_pixels {
                let mut buf = vec![0u8; channel_pixels];
                cursor.read_exact(&mut buf)?;
                buf
            } else {
                let mut buf = vec![0u8; data_len];
                cursor.read_exact(&mut buf)?;
                buf.resize(channel_pixels, 0);
                buf
            }
        } else {
            // RLE compressed
            decode_rle_channel(cursor, width as usize, height as usize)?
        };

        channels.push(channel_data);

        // Move to next channel
        let next_pos = channel_start + 8 + size as u64;
        cursor.seek(SeekFrom::Start(next_pos))?;
    }

    // Convert to RGBA
    let mut rgba = Vec::with_capacity(channel_pixels * 4);

    if n_channels == 3 && channels.len() >= 3 {
        // RGB -> RGBA
        let len = channels[0]
            .len()
            .min(channels[1].len())
            .min(channels[2].len())
            .min(channel_pixels);

        for i in 0..len {
            rgba.push(channels[0][i]);
            rgba.push(channels[1][i]);
            rgba.push(channels[2][i]);
            rgba.push(255);
        }
        // Pad if needed
        while rgba.len() < channel_pixels * 4 {
            rgba.extend_from_slice(&[0, 0, 0, 255]);
        }
    } else if !channels.is_empty() {
        // Grayscale -> RGBA
        for &gray in &channels[0] {
            rgba.push(gray);
            rgba.push(gray);
            rgba.push(gray);
            rgba.push(255);
        }
        // Pad if needed
        while rgba.len() < channel_pixels * 4 {
            rgba.extend_from_slice(&[0, 0, 0, 255]);
        }
    } else {
        return Err(PatError::InvalidFile("No channels decoded".into()));
    }

    Ok(rgba)
}

/// Find VMA header in buffer
fn find_vma_header(buf: &[u8], width: usize, height: usize) -> Option<usize> {
    for offset in 0..buf.len().saturating_sub(32) {
        let d = &buf[offset..];

        let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
        let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
        let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
        let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
        let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
        let depth = i16::from_be_bytes([d[28], d[29]]);
        let compression = d[30];

        let h_diff = bottom.saturating_sub(top);
        let w_diff = right.saturating_sub(left);

        if h_diff <= 0 || w_diff <= 0 {
            continue;
        }

        let vma_h = h_diff as usize;
        let vma_w = w_diff as usize;

        // Check dimensions match (allow swapped)
        let dims_ok = (vma_h == height && vma_w == width) || (vma_h == width && vma_w == height);

        if (0..=10).contains(&version)
            && size > 0
            && size < 100_000_000
            && dims_ok
            && depth == 8
            && compression <= 1
        {
            return Some(offset);
        }
    }
    None
}

/// Decode RLE compressed channel
fn decode_rle_channel(
    cursor: &mut Cursor<&[u8]>,
    width: usize,
    height: usize,
) -> Result<Vec<u8>, PatError> {
    let row_table_size = height * 2;
    let mut row_table = vec![0u8; row_table_size];
    cursor.read_exact(&mut row_table)?;

    let row_lengths: Vec<usize> = (0..height)
        .map(|i| u16::from_be_bytes([row_table[i * 2], row_table[i * 2 + 1]]) as usize)
        .collect();

    let mut decoded = Vec::with_capacity(width * height);

    for &row_len in &row_lengths {
        let mut row_data = vec![0u8; row_len];
        cursor.read_exact(&mut row_data)?;

        let row = decode_packbits(&row_data, width);
        decoded.extend(row);
    }

    // Ensure correct size
    decoded.resize(width * height, 0);
    Ok(decoded)
}

/// Decode PackBits compressed row
fn decode_packbits(input: &[u8], width: usize) -> Vec<u8> {
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
                let end = (i + count).min(input.len());
                let to_copy = (end - i).min(width - row.len());
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

/// Try to sync cursor to next pattern header
fn try_sync_to_next_pattern(cursor: &mut Cursor<&[u8]>, data_len: u64) -> bool {
    let scan_limit = (cursor.position() + 50000).min(data_len);

    while cursor.position() + 16 < scan_limit {
        let pos = cursor.position();

        if let Ok(ver) = cursor.read_u32::<BigEndian>() {
            if ver == 1 {
                if let Ok(mode) = cursor.read_u32::<BigEndian>() {
                    if mode < 50 {
                        if let Ok(h) = cursor.read_u16::<BigEndian>() {
                            if h > 0 && h < 8192 {
                                if let Ok(w) = cursor.read_u16::<BigEndian>() {
                                    if w > 0 && w < 8192 {
                                        // Found a candidate, rewind
                                        cursor.seek(SeekFrom::Start(pos)).ok();
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        cursor.seek(SeekFrom::Start(pos + 1)).ok();
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_test_patterns() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/test_patterns.pat");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping", path);
            return;
        }

        let patterns = parse_pat_file(&path).expect("Should parse .pat file");
        println!("Parsed {} patterns", patterns.len());

        for (i, p) in patterns.iter().enumerate() {
            println!(
                "  {}: '{}' ({}x{}, {:?})",
                i + 1,
                p.name,
                p.width,
                p.height,
                p.mode
            );

            // Verify RGBA data size
            let expected = (p.width * p.height * 4) as usize;
            assert_eq!(
                p.rgba_data.len(),
                expected,
                "Pattern {} RGBA size mismatch",
                i
            );
        }
    }
}
