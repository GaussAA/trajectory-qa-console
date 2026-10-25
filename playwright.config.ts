import { defineConfig } from '@playwright/test'

// 产品承诺是「双击 dist/index.html 就能用」，所以这里不起服务，直接以 file:// 打开构建产物。
// 用系统已装的 Chrome（channel），不下载 Playwright 自带的浏览器；CI 的 ubuntu-24.04 镜像自带 Chrome。
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: [['list']],
  // locale 决定界面语言（detectLocale 读 navigator.language）；断言用的是中文文案。
  use: { channel: 'chrome', locale: 'zh-CN', trace: 'retain-on-failure' },
})
