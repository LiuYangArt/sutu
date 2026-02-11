import { afterEach, describe, expect, it, vi } from 'vitest';
import { GradientRampLut } from './GradientRampLut';

function createFakeDevice() {
  const writeTexture = vi.fn();
  const createTexture = vi.fn(() => ({
    createView: vi.fn(() => ({})),
    destroy: vi.fn(),
  }));
  const createSampler = vi.fn(() => ({}));

  const device = {
    queue: {
      writeTexture,
    },
    createTexture,
    createSampler,
  } as unknown as GPUDevice;

  return {
    device,
    writeTexture,
  };
}

describe('GradientRampLut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads LUT and skips identical updates', () => {
    vi.stubGlobal('GPUTextureUsage', {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
    });
    const { device, writeTexture } = createFakeDevice();
    const lut = new GradientRampLut(device, 8);

    lut.update({
      colorStops: [
        { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
        { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
      ],
      opacityStops: [
        { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      reverse: false,
      transparency: true,
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
    });

    expect(writeTexture).toHaveBeenCalledTimes(1);
    const upload = writeTexture.mock.calls[0]?.[1] as Uint8Array;
    expect(upload).toBeInstanceOf(Uint8Array);
    expect(upload[0]).toBe(0);
    expect(upload[(8 - 1) * 4]).toBe(255);

    lut.update({
      colorStops: [
        { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
        { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
      ],
      opacityStops: [
        { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      reverse: false,
      transparency: true,
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
    });

    expect(writeTexture).toHaveBeenCalledTimes(1);
  });

  it('applies reverse and transparency options', () => {
    vi.stubGlobal('GPUTextureUsage', {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
    });
    const { device, writeTexture } = createFakeDevice();
    const lut = new GradientRampLut(device, 8);

    lut.update({
      colorStops: [
        { id: 'c0', position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
        { id: 'c1', position: 1, midpoint: 0.5, source: 'background', color: '#000000' },
      ],
      opacityStops: [
        { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'o1', position: 1, midpoint: 0.5, opacity: 0 },
      ],
      reverse: false,
      transparency: true,
      foregroundColor: '#ff0000',
      backgroundColor: '#0000ff',
    });

    const normalUpload = writeTexture.mock.calls[0]?.[1] as Uint8Array;
    expect(normalUpload[0]).toBeGreaterThan(200);
    expect(normalUpload[2]).toBe(0);
    expect(normalUpload[(8 - 1) * 4 + 3]).toBe(0);

    lut.update({
      colorStops: [
        { id: 'c0', position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
        { id: 'c1', position: 1, midpoint: 0.5, source: 'background', color: '#000000' },
      ],
      opacityStops: [
        { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'o1', position: 1, midpoint: 0.5, opacity: 0 },
      ],
      reverse: true,
      transparency: false,
      foregroundColor: '#ff0000',
      backgroundColor: '#0000ff',
    });

    expect(writeTexture).toHaveBeenCalledTimes(2);
    const reverseUpload = writeTexture.mock.calls[1]?.[1] as Uint8Array;
    expect(reverseUpload[0]).toBe(0);
    expect(reverseUpload[2]).toBeGreaterThan(200);
    expect(reverseUpload[3]).toBe(255);
    expect(reverseUpload[(8 - 1) * 4]).toBeGreaterThan(200);
    expect(reverseUpload[(8 - 1) * 4 + 3]).toBe(255);
  });
});
