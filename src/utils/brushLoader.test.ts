import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBrushTextureCacheForTests,
  loadBrushTexture,
  prewarmBrushTextures,
} from '@/utils/brushLoader';
import { decompressLz4PrependSize } from '@/utils/lz4';

vi.mock('@/utils/lz4', () => ({
  decompressLz4PrependSize: vi.fn(),
}));

interface MockResponse {
  ok: boolean;
  headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function createResponse(width: number, height: number, payload: Uint8Array): MockResponse {
  return {
    ok: true,
    headers: new Headers({
      'X-Image-Width': String(width),
      'X-Image-Height': String(height),
    }),
    arrayBuffer: async () => payload.slice().buffer as ArrayBuffer,
  };
}

describe('brushLoader cache behavior', () => {
  beforeEach(() => {
    __resetBrushTextureCacheForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('reuses cache for repeated requests of the same texture id', async () => {
    vi.mocked(decompressLz4PrependSize).mockReturnValue(new Uint8Array([10, 20, 30, 40]));
    const fetchMock = vi.fn().mockResolvedValue(createResponse(2, 2, new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadBrushTexture('tip-cache-hit', 2, 2);
    const second = await loadBrushTexture('tip-cache-hit', 2, 2);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in-flight requests for the same texture id', async () => {
    vi.useFakeTimers();
    vi.mocked(decompressLz4PrependSize).mockReturnValue(new Uint8Array([1, 2, 3, 4]));

    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<MockResponse>((resolve) => {
          setTimeout(() => {
            resolve(createResponse(2, 2, new Uint8Array([9, 9, 9, 9])));
          }, 5);
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pendingA = loadBrushTexture('tip-inflight', 2, 2);
    const pendingB = loadBrushTexture('tip-inflight', 2, 2);
    await vi.advanceTimersByTimeAsync(10);

    const [a, b] = await Promise.all([pendingA, pendingB]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('does not cache failed requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([0]).slice().buffer as ArrayBuffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadBrushTexture('tip-failed', 2, 2);
    const second = await loadBrushTexture('tip-failed', 2, 2);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prewarms unique texture ids up to maxCount', async () => {
    vi.useFakeTimers();
    vi.mocked(decompressLz4PrependSize).mockReturnValue(new Uint8Array([8, 8, 8, 8]));
    const fetchMock = vi.fn().mockResolvedValue(createResponse(2, 2, new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal('fetch', fetchMock);

    prewarmBrushTextures(
      [
        { id: 'a', width: 2, height: 2 },
        { id: 'a', width: 2, height: 2 },
        { id: 'b', width: 2, height: 2 },
        { id: 'c', width: 2, height: 2 },
      ],
      2
    );

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/brush/a');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/brush/b');
  });
});
