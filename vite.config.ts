import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Single-file build: every asset inlined so the artifact can be opened by
// double-click from any path, with no server and no network access.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
