/** HTML 报告在真实浏览器里的行为：默认折叠、总览表跳转、打印。
 *  jsdom 没有 `::details-content`，也不会真的排版或打印，这些只能在 Chrome 里验。
 *  报告由构建好的 CLI 生成，所以先 `pnpm build:cli`，再 `pnpm test:e2e`。 */

import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLI = resolve('dist-cli', 'qa.mjs')
let dir = ''
let url = ''

test.beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`缺少 ${CLI}，请先运行 pnpm build:cli`)
  dir = mkdtempSync(join(tmpdir(), 'tqa-html-report-'))
  // 示例里有带 error 的坏会话，也有健康的，正好覆盖两种默认状态。
  execFileSync('node', [CLI, 'examples', '--out', dir, '--format', 'html', '--quiet'], { stdio: 'pipe' })
  url = pathToFileURL(join(dir, 'report.html')).href
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** 每个会话 <details> 的 id、是否默认展开。 */
async function sessions(page: Page): Promise<{ id: string; open: boolean }[]> {
  return page.$$eval('details.session', (nodes) =>
    nodes.map((node) => ({ id: node.id, open: (node as HTMLDetailsElement).open })),
  )
}

/** 会话正文里的维度条：它在 <details> 内容里，收起时不可见。 */
const body = (page: Page, id: string) => page.locator(`#${id} .dims`)

test('opens the sessions with errors and folds the healthy ones', async ({ page }) => {
  await page.goto(url)
  const all = await sessions(page)

  expect(all.length).toBeGreaterThan(1)
  expect(all.some((session) => session.open)).toBe(true)
  expect(all.some((session) => !session.open)).toBe(true)

  for (const session of all) {
    const errors = await page.locator(`#${session.id} .finding.sev-error`).count()
    expect(session.open, `${session.id} 的默认状态应与是否含 error 一致`).toBe(errors > 0)
  }
})

test('jumping from the overview table shows a folded session', async ({ page }) => {
  await page.goto(url)
  const folded = (await sessions(page)).find((session) => !session.open)
  if (!folded) throw new Error('示例里没有会被收起的会话')

  await expect(body(page, folded.id)).toBeHidden()
  await page.locator(`td.name a[href="#${folded.id}"]`).click()

  await expect(page).toHaveURL(new RegExp(`#${folded.id}$`))
  await expect(body(page, folded.id)).toBeVisible()
  // 目标会话的折叠头也要在视口里，不能跳到一半。
  await expect(page.locator(`#${folded.id} > summary`)).toBeInViewport()
})

test('prints every session in full, folded or not', async ({ page }) => {
  await page.goto(url)
  const all = await sessions(page)
  await page.emulateMedia({ media: 'print' })

  for (const session of all) {
    await expect(body(page, session.id), `${session.id} 打印时应可见`).toBeVisible()
  }
})

test('stays script-free and loads nothing external', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.goto(url)

  expect(await page.locator('script').count()).toBe(0)
  expect(requests.filter((item) => !/^(file|data|blob|about):/.test(item))).toEqual([])
})
