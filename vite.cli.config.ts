import { defineConfig } from 'vite'

// Node 侧产物：把 CLI 连同 core 一起打成单个 .mjs，运行时不需要 node_modules。
// 与 UI 的单文件构建互不影响（后者在 vite.config.ts）。
export default defineConfig({
  // Vite 的 SSR 构建默认把 dependencies 外置；CLI 要能单独拷走运行，
  // 所以强制把 zod 一起打进来（冒烟测试会断言除 node: 外无裸模块）。
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-cli',
    emptyOutDir: true,
    minify: false,
    reportCompressedSize: false,
    lib: {
      entry: 'src/cli/bin.ts',
      formats: ['es'],
      fileName: () => 'qa.mjs',
    },
    rollupOptions: {
      // 源文件自带 shebang，esbuild 会保留到产物首行；再加 banner 会变成两行。
      external: [/^node:/],
      // ssr 模式下 lib.fileName 不生效，直接钉死产物名（bin 字段依赖它）。
      output: { entryFileNames: 'qa.mjs' },
    },
  },
})
