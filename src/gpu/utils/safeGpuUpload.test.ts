import { describe, expect, it } from 'vitest';
import { safeWriteBuffer } from './safeGpuUpload';

describe('safeWriteBuffer', () => {
  it('writes in a single chunk when size <= maxChunkBytes', () => {
    const calls: Array<{ dstOffset: number; srcOffset: number; size: number }> = [];
    const device = {
      limits: { maxBufferSize: 64 },
      queue: {
        writeBuffer: (
          _dst: GPUBuffer,
          dstOffset: number,
          _src: BufferSource,
          srcOffset: number = 0,
          size: number = 0
        ) => {
          calls.push({ dstOffset, srcOffset, size });
        },
      },
    } as unknown as GPUDevice;

    const dstBuffer = { size: 256 } as unknown as GPUBuffer;
    const src = new Uint8Array(32);

    safeWriteBuffer({
      device,
      dstBuffer,
      dstOffset: 0,
      src,
      srcOffset: 0,
      size: 32,
      label: 'single',
    });

    expect(calls).toEqual([{ dstOffset: 0, srcOffset: 0, size: 32 }]);
  });

  it('splits into multiple chunks when size > maxChunkBytes', () => {
    const calls: Array<{ dstOffset: number; srcOffset: number; size: number }> = [];
    const device = {
      limits: { maxBufferSize: 16 },
      queue: {
        writeBuffer: (
          _dst: GPUBuffer,
          dstOffset: number,
          _src: BufferSource,
          srcOffset: number = 0,
          size: number = 0
        ) => {
          calls.push({ dstOffset, srcOffset, size });
        },
      },
    } as unknown as GPUDevice;

    const dstBuffer = { size: 256 } as unknown as GPUBuffer;
    const src = new Uint8Array(40);

    safeWriteBuffer({
      device,
      dstBuffer,
      dstOffset: 0,
      src,
      srcOffset: 0,
      size: 40,
      label: 'chunk',
    });

    expect(calls).toEqual([
      { dstOffset: 0, srcOffset: 0, size: 16 },
      { dstOffset: 16, srcOffset: 16, size: 16 },
      { dstOffset: 32, srcOffset: 32, size: 8 },
    ]);
  });

  it('throws on non-4-byte alignment', () => {
    const device = {
      limits: { maxBufferSize: 64 },
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
    const dstBuffer = { size: 256 } as unknown as GPUBuffer;
    const src = new Uint8Array(32);

    expect(() =>
      safeWriteBuffer({
        device,
        dstBuffer,
        dstOffset: 2,
        src,
        srcOffset: 0,
        size: 32,
        label: 'align',
      })
    ).toThrow(/4-byte aligned/);
  });

  it('throws on out-of-bounds write', () => {
    const device = {
      limits: { maxBufferSize: 64 },
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
    const dstBuffer = { size: 32 } as unknown as GPUBuffer;
    const src = new Uint8Array(64);

    expect(() =>
      safeWriteBuffer({
        device,
        dstBuffer,
        dstOffset: 0,
        src,
        srcOffset: 0,
        size: 40,
        label: 'oob',
      })
    ).toThrow(/out of bounds/);
  });
});
