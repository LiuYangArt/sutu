import '@testing-library/jest-dom/vitest';

// Polyfill ImageData for jsdom environments where it's missing.
// Supports both constructor overloads:
// - new ImageData(width, height)
// - new ImageData(Uint8ClampedArray, width, height)
if (typeof globalThis.ImageData === 'undefined') {
  class SimpleImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;

    constructor(width: number, height: number);
    constructor(data: Uint8ClampedArray, width: number, height: number);
    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight: number,
      heightMaybe?: number
    ) {
      if (typeof dataOrWidth === 'number') {
        const width = dataOrWidth;
        const height = widthOrHeight;
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
        return;
      }

      const data = dataOrWidth;
      const width = widthOrHeight;
      const height = heightMaybe ?? 0;
      this.width = width;
      this.height = height;

      const expectedLen = width * height * 4;
      if (data.length === expectedLen) {
        this.data = data;
      } else {
        const next = new Uint8ClampedArray(expectedLen);
        next.set(data.subarray(0, expectedLen));
        this.data = next;
      }
    }
  }

  // @ts-expect-error - Injecting ImageData for jsdom fallback
  globalThis.ImageData = SimpleImageData;
}

// Mock localStorage for zustand persist middleware
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock Tauri API
vi.mock('@tauri-apps/api', () => ({
  invoke: vi.fn(),
  event: {
    listen: vi.fn(() => Promise.resolve(() => {})),
    emit: vi.fn(),
  },
}));

// Mock WebGPU (not available in jsdom)
Object.defineProperty(navigator, 'gpu', {
  value: undefined,
  writable: true,
});

// Suppress console warnings in tests
const originalWarn = console.warn;
console.warn = (...args) => {
  if (args[0]?.includes?.('WebGPU')) return;
  originalWarn(...args);
};
