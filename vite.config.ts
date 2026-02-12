import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Tauri 开发服务器配置
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_'],

  // Force pre-bundle CommonJS dependencies
  optimizeDeps: {
    include: ['lz4js'],
  },

  build: {
    // Tauri 使用 Chromium，支持最新 ES 特性
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');

          if (normalizedId.includes('/node_modules/')) {
            if (normalizedId.includes('/zustand/') || normalizedId.includes('/immer/')) {
              return 'vendor-state';
            }
            if (normalizedId.includes('/@tauri-apps/')) {
              return 'vendor-tauri';
            }
            if (normalizedId.includes('/lucide-react/') || normalizedId.includes('/react-colorful/')) {
              return 'vendor-ui';
            }
            if (normalizedId.includes('/lz4js/')) {
              return 'vendor-lz4';
            }
            return 'vendor';
          }

          if (normalizedId.includes('/src/gpu/')) {
            return 'gpu-core';
          }

          return undefined;
        },
      },
    },
    commonjsOptions: {
      include: [/lz4js/, /node_modules/],
    },
  },
});
