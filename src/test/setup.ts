import '@testing-library/jest-dom/vitest';

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
