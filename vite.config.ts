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
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/app/**/*.ts',
        'src/ui/windowing.ts',
        'src/i18n/**/*.{ts,tsx}',
        'src/cli/**/*.ts',
        'src/lib/**/*.ts',
      ],
      exclude: ['**/*.test.{ts,tsx}', 'src/core/sample.ts', '**/test-support.ts', 'src/core/__golden__/**', 'src/cli/bin.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 75,
      },
    },
  },
})
