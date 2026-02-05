export const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024; // 64MB

function assertFourByteAligned(value: number, label: string): void {
  if (value % 4 !== 0) {
    throw new Error(`[safeGpuUpload] ${label} must be 4-byte aligned, got ${value}`);
  }
}

function getBufferSourceByteLength(src: BufferSource): number {
  if (src instanceof ArrayBuffer) {
    return src.byteLength;
  }
  if (typeof SharedArrayBuffer !== 'undefined' && src instanceof SharedArrayBuffer) {
    return src.byteLength;
  }
  // ArrayBufferView
  return src.byteLength;
}

export function getMaxChunkBytes(device: GPUDevice): number {
  const max = Math.min(device.limits.maxBufferSize, DEFAULT_MAX_CHUNK_BYTES);
  // WebGPU requires writeBuffer size/dataOffset to be multiples of 4.
  return max - (max % 4);
}

export function safeWriteBuffer(args: {
  device: GPUDevice;
  dstBuffer: GPUBuffer;
  dstOffset: number;
  src: BufferSource;
  srcOffset: number;
  size: number;
  label: string;
}): void {
  const { device, dstBuffer, dstOffset, src, srcOffset, size, label } = args;

  if (size <= 0) {
    return;
  }

  assertFourByteAligned(dstOffset, `${label}: dstOffset`);
  assertFourByteAligned(srcOffset, `${label}: srcOffset`);
  assertFourByteAligned(size, `${label}: size`);

  if (dstOffset + size > dstBuffer.size) {
    throw new Error(
      `[safeGpuUpload] ${label}: write out of bounds (dstOffset=${dstOffset}, size=${size}, dstSize=${dstBuffer.size})`
    );
  }

  const srcByteLength = getBufferSourceByteLength(src);
  if (srcOffset + size > srcByteLength) {
    throw new Error(
      `[safeGpuUpload] ${label}: read out of bounds (srcOffset=${srcOffset}, size=${size}, srcSize=${srcByteLength})`
    );
  }

  const maxChunkBytes = getMaxChunkBytes(device);
  if (maxChunkBytes <= 0) {
    throw new Error(`[safeGpuUpload] ${label}: invalid maxChunkBytes=${maxChunkBytes}`);
  }

  if (size <= maxChunkBytes) {
    device.queue.writeBuffer(dstBuffer, dstOffset, src, srcOffset, size);
    return;
  }

  let written = 0;
  while (written < size) {
    const remaining = size - written;
    const chunkSize = Math.min(remaining, maxChunkBytes);
    // chunkSize is always 4-byte aligned because maxChunkBytes and size are.
    device.queue.writeBuffer(dstBuffer, dstOffset + written, src, srcOffset + written, chunkSize);
    written += chunkSize;
  }
}
