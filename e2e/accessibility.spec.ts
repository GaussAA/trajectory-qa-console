/** 无障碍自动检查：对构建产物的主要界面状态跑 axe（WCAG 2.0/2.1 的 A 与 AA）。
 *  先 `pnpm build`，再 `pnpm test:e2e`。
 *
 *  只断言「违规」（violations）。axe 判断不了的项（incomplete）不算通过也不算失败，
 *  见下面 `flatten` 的说明。 */

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ARTIFACT = resolve('dist', 'index.html')
const BASE = pathToFileURL(ARTIFACT).href
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

test.beforeAll(() => {
  if (!existsSync(ARTIFACT)) throw new Error(`缺少 ${ARTIFACT}，请先运行 pnpm build`)
})

/** 界面的背景是渐变加毛玻璃。axe 算不出渐变底上的对比度，会把整页上百个文字都放进 incomplete，
 *  等于没检查。这里把渐变和模糊换成纯底色再扫；同时关掉动画，否则会截到淡入途中的颜色（toast 就出现过误报）：渐变本身只是极淡的色调（透明度 0.1 左右），
 *  对文字对比度的影响远小于判定边界，用纯底色近似是可接受的。
 *  代价是：真正落在渐变上的对比度没有被测到。 */
async function flatten(page: Page) {
  await page.addStyleTag({
    content:
      '*{background-image:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;animation:none !important;transition:none !important}',
  })
}

async function violationsOf(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  return results.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id} [${violation.impact}] ${node.target.join(' ')}: ${node.failureSummary?.split('\n')[1]?.trim() ?? violation.help}`,
    ),
  )
}

async function open(page: Page, suffix = '') {
  await page.goto(BASE + suffix)
  await flatten(page)
}

async function loadDemo(page: Page) {
  await page.getByRole('button', { name: /载入示例|Load samples/ }).click()
  await expect(page.getByRole('button', { name: /demo-0/ })).toHaveCount(4)
}

test('the empty state has no violations', async ({ page }) => {
  await open(page)
  expect(await violationsOf(page)).toEqual([])
})

test('every demo session has no violations, including the pages that only some sessions show', async ({
  page,
}) => {
  // 有的元素只在某些会话里出现（比如问题清单里的证据片段），所以逐个会话扫。
  await open(page)
  await loadDemo(page)
  const sessions = page.getByRole('button', { name: /demo-0/ })
  const found: string[] = []
  for (let index = 0; index < (await sessions.count()); index += 1) {
    await sessions.nth(index).click()
    found.push(...(await violationsOf(page)).map((line) => `session ${index}: ${line}`))
  }
  expect(found).toEqual([])
})

test.describe('the other views', () => {
  const views: [string, string][] = [
    ['rules drawer', '?drawer=1#demo'],
    ['diagnostics drawer', '?diag=1#demo'],
    ['comparison', '?compare#demo'],
    ['English', '?lang=en#demo'],
  ]

  for (const [name, suffix] of views) {
    test(`${name} has no violations`, async ({ page }) => {
      await open(page, suffix)
      await expect(page.getByRole('button', { name: /demo-0/ })).toHaveCount(4)
      expect(await violationsOf(page)).toEqual([])
    })
  }
})

test('the scan can fail: a low-contrast text and a nameless button are both reported', async ({ page }) => {
  // 反例：防止「扫描根本没在工作所以永远是 0」。
  await open(page)
  await page.evaluate(() => {
    const bad = document.createElement('div')
    bad.setAttribute('style', 'position:fixed;top:4px;left:4px;z-index:99999;color:#ccc;background:#fff')
    bad.innerHTML = 'low contrast text<button></button>'
    document.body.appendChild(bad)
  })
  const ids = (await violationsOf(page)).map((line) => line.split(' ')[0])
  expect(ids).toEqual(expect.arrayContaining(['color-contrast', 'button-name']))
})
