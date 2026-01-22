//! PackBits RLE compression/decompression
//!
//! PackBits is the compression algorithm used in PSD files.
//! Reference: Apple Technical Note TN1023

use std::io::{self, Cursor, Read};

use byteorder::ReadBytesExt;

/// PackBits compression error
#[derive(Debug, thiserror::Error)]
pub enum CompressionError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),

    #[error("Unexpected end of data")]
    UnexpectedEof,

    #[error("Decompression output size mismatch: expected {expected}, got {actual}")]
    SizeMismatch { expected: usize, actual: usize },
}

/// Encode data using PackBits RLE compression
///
/// Algorithm rules:
/// - N >= 0: Next N+1 bytes are literal (copy as-is)
/// - -127 <= N < 0: Repeat next byte (1-N) times
/// - N = -128: No operation (used for padding)
///
/// Returns compressed data
pub fn packbits_encode(input: &[u8]) -> Vec<u8> {
    if input.is_empty() {
        return Vec::new();
    }

    let mut output = Vec::with_capacity(input.len());
    let mut i = 0;

    while i < input.len() {
        // Detect run of identical bytes
        let mut run_len = 1;
        while i + run_len < input.len() && input[i + run_len] == input[i] && run_len < 128 {
            run_len += 1;
        }

        if run_len >= 3 {
            // Write run-length encoding: -(run_len - 1), byte
            // For run_len = 3, we write -2 (0xFE), byte
            output.push((1_i16 - run_len as i16) as u8);
            output.push(input[i]);
            i += run_len;
        } else {
            // Collect literal sequence
            let start = i;

            while i < input.len() && i - start < 128 {
                // Look ahead: if next 3+ bytes are identical, stop literal sequence
                if i + 2 < input.len()
                    && input[i] == input[i + 1]
                    && input[i] == input[i + 2]
                    && i > start
                {
                    break;
                }
                i += 1;
            }

            let literal_len = i - start;
            if literal_len > 0 {
                // Write literal: (literal_len - 1), bytes...
                output.push((literal_len - 1) as u8);
                output.extend_from_slice(&input[start..i]);
            }
        }
    }

    output
}

/// Decode PackBits RLE compressed data
///
/// # Arguments
/// * `input` - Compressed data
/// * `expected_len` - Expected decompressed size
///
/// # Returns
/// Decompressed data
pub fn packbits_decode(input: &[u8], expected_len: usize) -> Result<Vec<u8>, CompressionError> {
    let mut output = Vec::with_capacity(expected_len);
    let mut cursor = Cursor::new(input);

    while output.len() < expected_len && cursor.position() < input.len() as u64 {
        let n = cursor.read_i8()?;

        if n >= 0 {
            // Literal: copy next (n + 1) bytes
            let count = (n as usize) + 1;
            let mut bytes = vec![0u8; count];
            cursor.read_exact(&mut bytes)?;
            output.extend(bytes);
        } else if n > -128 {
            // Run: repeat next byte (1 - n) times
            let count = (1 - n as i16) as usize;
            let byte = cursor.read_u8()?;
            output.extend(std::iter::repeat(byte).take(count));
        }
        // n == -128 is a no-op
    }

    if output.len() != expected_len {
        return Err(CompressionError::SizeMismatch {
            expected: expected_len,
            actual: output.len(),
        });
    }

    Ok(output)
}

/// Encode a single scanline and return (row_byte_count, compressed_data)
pub fn encode_scanline(row: &[u8]) -> (u16, Vec<u8>) {
    let compressed = packbits_encode(row);
    (compressed.len() as u16, compressed)
}

/// Encode multiple scanlines, returning row counts and concatenated compressed data
pub fn encode_channel(rows: &[&[u8]]) -> (Vec<u16>, Vec<u8>) {
    let mut row_counts = Vec::with_capacity(rows.len());
    let mut compressed_data = Vec::new();

    for row in rows {
        let (count, data) = encode_scanline(row);
        row_counts.push(count);
        compressed_data.extend(data);
    }

    (row_counts, compressed_data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_empty() {
        let result = packbits_encode(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_encode_single_byte() {
        let result = packbits_encode(&[42]);
        assert_eq!(result, vec![0, 42]); // 0 = 1 literal byte
    }

    #[test]
    fn test_encode_run() {
        // 5 identical bytes should be encoded as run
        let result = packbits_encode(&[0xAA; 5]);
        // -4 (0xFC) means repeat 5 times, then the byte
        assert_eq!(result, vec![0xFC, 0xAA]);
    }

    #[test]
    fn test_encode_literal() {
        let result = packbits_encode(&[1, 2, 3, 4]);
        // 3 = 4 literal bytes
        assert_eq!(result, vec![3, 1, 2, 3, 4]);
    }

    #[test]
    fn test_encode_mixed() {
        // Literal followed by run
        let input = vec![1, 2, 3, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA];
        let result = packbits_encode(&input);
        // Should be: [2, 1, 2, 3] (3 literals) + [0xFC, 0xAA] (5-run)
        assert_eq!(result, vec![2, 1, 2, 3, 0xFC, 0xAA]);
    }

    #[test]
    fn test_decode_literal() {
        let compressed = vec![3, 1, 2, 3, 4]; // 4 literal bytes
        let result = packbits_decode(&compressed, 4).unwrap();
        assert_eq!(result, vec![1, 2, 3, 4]);
    }

    #[test]
    fn test_decode_run() {
        let compressed = vec![0xFC, 0xAA]; // Repeat 0xAA 5 times
        let result = packbits_decode(&compressed, 5).unwrap();
        assert_eq!(result, vec![0xAA; 5]);
    }

    #[test]
    fn test_roundtrip() {
        let original: Vec<u8> = (0..256).map(|i| (i % 256) as u8).collect();
        let compressed = packbits_encode(&original);
        let decompressed = packbits_decode(&compressed, original.len()).unwrap();
        assert_eq!(original, decompressed);
    }

    #[test]
    fn test_roundtrip_runs() {
        let mut original = Vec::new();
        for i in 0..10 {
            original.extend(std::iter::repeat(i as u8).take(20));
        }
        let compressed = packbits_encode(&original);
        let decompressed = packbits_decode(&compressed, original.len()).unwrap();
        assert_eq!(original, decompressed);
    }

    #[test]
    fn test_roundtrip_realistic() {
        // Simulate image data with some patterns
        let mut original = Vec::new();
        // Some runs (transparent area)
        original.extend(std::iter::repeat(0u8).take(100));
        // Some varied data (edge)
        original.extend((0..50).map(|i| (i * 5) as u8));
        // Another run
        original.extend(std::iter::repeat(255u8).take(80));

        let compressed = packbits_encode(&original);
        let decompressed = packbits_decode(&compressed, original.len()).unwrap();
        assert_eq!(original, decompressed);

        // Verify compression is effective
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn test_encode_channel() {
        let row1 = vec![0u8; 10];
        let row2 = vec![255u8; 10];
        let rows: Vec<&[u8]> = vec![&row1, &row2];

        let (counts, data) = encode_channel(&rows);
        assert_eq!(counts.len(), 2);
        assert!(!data.is_empty());
    }
}
