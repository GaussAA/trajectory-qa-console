/** 以 file:// 打开构建产物 dist/index.html，验证「单文件、离线、双击即用」的产品承诺。
 *  jsdom 测不到这些：Blob worker 在 file:// 下被浏览器拦、localStorage 可能不可用、有没有偷偷发请求。
 *  先 `pnpm build`，再 `pnpm test:e2e`。 */

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ARTIFACT = resolve('dist', 'index.html')
const URL_ = pathToFileURL(ARTIFACT).href

test.beforeAll(() => {
  if (!existsSync(ARTIFACT)) throw new Error(`缺少 ${ARTIFACT}，请先运行 pnpm build`)
})

/** 记录页面上的错误与请求，用例末尾统一断言。 */
function watch(page: Page) {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  page.on('request', (request) => requests.push(request.url()))
  return { errors, requests }
}

/** file://、data:、blob: 之外的请求，都说明产物不再自包含。 */
function external(requests: string[]): string[] {
  return requests.filter((url) => !/^(file|data|blob|about):/.test(url))
}

test('opens from file:// with no errors and no network requests', async ({ page }) => {
  const seen = watch(page)
  await page.goto(URL_)
  await expect(page.getByText('把轨迹拖进来，四面体检')).toBeVisible()
  expect(seen.errors).toEqual([])
  expect(external(seen.requests)).toEqual([])
})

test('loads the four demo traces', async ({ page }) => {
  const seen = watch(page)
  await page.goto(URL_)
  await page.getByRole('button', { name: /载入示例/ }).click()
  await expect(page.getByText('时间线')).toBeVisible()
  await expect(page.getByRole('button', { name: /demo-0/ })).toHaveCount(4)
  expect(seen.errors).toEqual([])
})

test('analyses an input over the worker threshold, where file:// forces the sync fallback', async ({
  page,
}) => {
  const seen = watch(page)
  await page.goto(URL_)

  // 每条约 120 字节，3000 条超过 256 KB 的 worker 阈值；file:// 下 worker 不可用，必须回退到同步分析。
  const messages = Array.from({ length: 3000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${index} 条消息：这是一段用来撑大输入体积的普通文本，不触发任何规则。`,
  }))
  const buffer = Buffer.from(JSON.stringify(messages))
  expect(buffer.byteLength).toBeGreaterThan(256 * 1024)

  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'big.json',
    mimeType: 'application/json',
    buffer,
  })

  await expect(page.getByText('时间线')).toBeVisible({ timeout: 15_000 })
  expect(seen.errors).toEqual([])
})

test('exports a self-contained HTML report', async ({ page }) => {
  await page.goto(URL_)
  await page.getByRole('button', { name: /载入示例/ }).click()
  await expect(page.getByText('时间线')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'HTML 报告' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.html$/)

  const path = await download.path()
  const html = readFileSync(path, 'utf8')
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).not.toMatch(/<script/i)
  expect(html).not.toMatch(/src=["']https?:/i)
})
