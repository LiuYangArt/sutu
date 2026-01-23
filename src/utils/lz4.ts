/**
 * LZ4 decompression utilities for lz4_flex::compress_prepend_size format
 *
 * Format: 4-byte little-endian uncompressed size + raw LZ4 block
 */
import * as lz4 from 'lz4js';

/**
 * Decompress LZ4 data in lz4_flex prepend_size format
 * @param compressed - Compressed data with 4-byte size header
 * @returns Decompressed Uint8Array
 */
export function decompressLz4PrependSize(compressed: Uint8Array): Uint8Array {
  // Read prepended size (4 bytes, little-endian u32)
  const uncompressedSize =
    compressed[0]! | (compressed[1]! << 8) | (compressed[2]! << 16) | (compressed[3]! << 24);

  // Allocate output buffer and decompress
  // decompressBlock(src, dst, sIndex, sLength, dIndex)
  const decompressed = new Uint8Array(uncompressedSize);
  lz4.decompressBlock(compressed, decompressed, 4, compressed.length - 4, 0);

  return decompressed;
}
