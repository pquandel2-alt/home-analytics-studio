/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = process.env.HAS_DEV_BACKEND || 'http://localhost:18100'

export default defineConfig({
  // relative asset paths: works behind HA ingress and reverse proxies with any base path
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target, ws: true, changeOrigin: false } },
  },
  build: {
    // TV browsers (Samsung Tizen ~Chromium 76, LG webOS, Fire TV Silk) need older JS syntax
    target: ['es2019', 'chrome69', 'safari12'],
    cssTarget: ['chrome69', 'safari12'],
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          grid: ['react-grid-layout'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
