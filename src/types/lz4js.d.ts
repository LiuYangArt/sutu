// Type declarations for lz4js
declare module 'lz4js' {
  /**
   * Decompress LZ4 framed data (NOT compatible with lz4_flex block format)
   */
  export function decompress(input: Uint8Array): Uint8Array;

  /**
   * Decompress a raw LZ4 block into the provided output buffer
   * @param src - Compressed LZ4 block data
   * @param dst - Pre-allocated output buffer (must be large enough)
   * @param sIndex - Start index in source (default 0)
   * @param sLength - Length of compressed data in source
   * @param dIndex - Start index in destination (default 0)
   * @returns New destination index after decompression
   */
  export function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number
  ): number;

  /**
   * Compress data using LZ4 algorithm
   */
  export function compress(input: Uint8Array): Uint8Array;
}
