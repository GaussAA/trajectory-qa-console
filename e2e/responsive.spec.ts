/** 响应式回归：在真实浏览器里按宽度逐档渲染，量元素的实际位置。
 *  `src/styles/responsive.test.ts` 只读样式文件，能钉住「写了什么」，钉不住「渲染出来是什么」：
 *  按钮被挤出视口、横向滚动条、断点区间写错，样式文件看起来都完全正常。
 *  先 `pnpm build`，再 `pnpm test:e2e`。
 *
 *  断言的是几何事实，不是截图：
 *  - 任何宽度都不出现横向滚动，所有可操作的控件都落在视口内（包括「导出报告」这类输出动作）；
 *  - 三种布局形态（三栏、图标条、单栏堆叠）在对应宽度里各自成立。
 *
 *  取宽度时刻意避开断点的整数边界（1279、1280、1023、1024）：浏览器对媒体查询的取整在边界上
 *  不一定和 innerWidth 一致，在边界上断言只会得到一个不稳定的测试。 */

import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ARTIFACT = resolve('dist', 'index.html')
const BASE = pathToFileURL(ARTIFACT).href

test.beforeAll(() => {
  if (!existsSync(ARTIFACT)) throw new Error(`缺少 ${ARTIFACT}，请先运行 pnpm build`)
})

type Size = readonly [width: number, height: number]

/** 覆盖三种形态以及它们之间的过渡带，最后两档是手机宽度（产品不做手机版，但底线是不溢出）。 */
const SIZES: readonly Size[] = [
  [1920, 1080],
  [1440, 900],
  [1340, 800],
  [1200, 800],
  [1060, 768],
  [900, 900],
  [600, 900],
  [480, 800],
  [375, 700],
]

/** 关掉过渡与动画：抽屉的滑入、toast 的淡入会让量到的位置停在半路。 */
async function freeze(page: Page) {
  await page.addStyleTag({ content: '*{animation:none !important;transition:none !important}' })
}

async function open(page: Page, suffix: string) {
  // 先在默认视口（1280 宽，完整三栏）里打开：图标条形态下会话按钮的文字被收起，按名字找不到。
  await page.goto(BASE + suffix)
  await freeze(page)
  await expect(page.getByRole('button', { name: /demo-0/ })).toHaveCount(4)
}

async function resize(page: Page, [width, height]: Size) {
  await page.setViewportSize({ width, height })
  // 两帧：让样式重算、容器查询重新求值之后再量。
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}

/** 当前视口里不合格的地方，每条一句话；空数组表示合格。 */
async function problemsOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth) {
      found.push(`页面可以横向滚动（内容 ${root.scrollWidth}px，视口 ${root.clientWidth}px）`)
    }
    const nameOf = (element: Element) =>
      (element.getAttribute('aria-label') || element.textContent || element.className || element.tagName)
        .toString()
        .trim()
        .slice(0, 24)
    for (const element of document.querySelectorAll('button, select, input, textarea, a[href]')) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden') continue
      if (box.left < -0.5 || box.right > window.innerWidth + 0.5) {
        found.push(`「${nameOf(element)}」超出视口（${Math.round(box.left)} 到 ${Math.round(box.right)}）`)
      }
    }
    return found
  })
}

/** 一个界面状态在所有宽度下逐档检查，把全部问题一次报出来，不是遇到第一个就停。 */
async function sweep(page: Page, check: (size: Size) => Promise<string[]>): Promise<string[]> {
  const found: string[] = []
  for (const size of SIZES) {
    await resize(page, size)
    found.push(...(await check(size)).map((line) => `${size[0]}x${size[1]}: ${line}`))
  }
  return found
}

test.describe('no control is pushed out of the viewport', () => {
  const states: [string, string][] = [
    ['main view', '#demo'],
    ['English labels, which are longer', '?lang=en#demo'],
    ['rules drawer', '?drawer=1#demo'],
    ['diagnostics drawer', '?diag=1#demo'],
    ['comparison', '?compare#demo'],
  ]

  for (const [name, suffix] of states) {
    test(name, async ({ page }) => {
      await open(page, suffix)
      expect(await sweep(page, () => problemsOf(page))).toEqual([])
    })
  }
})

test('desktop widths never need a vertical page scroll', async ({ page }) => {
  // 桌面形态是「整个界面一屏装下，面板各自内部滚动」；单栏堆叠才允许页面本身滚动。
  await open(page, '#demo')
  const found = await sweep(page, async ([width]) => {
    if (width < 1060) return []
    return page.evaluate(() => {
      const root = document.documentElement
      return root.scrollHeight > window.innerHeight
        ? [`页面出现纵向滚动（内容 ${root.scrollHeight}px，视口 ${window.innerHeight}px）`]
        : []
    })
  })
  expect(found).toEqual([])
})

test.describe('each layout shape holds at its widths', () => {
  type Rect = { left: number; right: number; top: number; bottom: number; width: number }

  async function rects(page: Page) {
    return page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element || getComputedStyle(element).display === 'none') return null
        const { left, right, top, bottom, width } = element.getBoundingClientRect()
        return { left, right, top, bottom, width }
      }
      return {
        sessions: read('.session-list'),
        narrowPicker: read('.narrow-session'),
        timeline: read('.timeline-panel'),
        inspector: read('.inspector'),
        findings: read('.findings-panel'),
      }
    })
  }

  const must = (rect: Rect | null, what: string): Rect => {
    expect(rect, `${what} 应该在页面上`).not.toBeNull()
    return rect as Rect
  }

  test('three columns on wide screens: sessions, timeline and details sit side by side', async ({ page }) => {
    await open(page, '#demo')
    for (const size of SIZES.filter(([width]) => width >= 1340)) {
      await resize(page, size)
      const { sessions, timeline, inspector, narrowPicker } = await rects(page)
      const at = `${size[0]}px`
      expect(narrowPicker, `${at}: 完整左栏时不该有顶部会话下拉`).toBeNull()
      expect(must(sessions, '会话列表').right, `${at}: 会话列表在时间线左侧`).toBeLessThanOrEqual(
        must(timeline, '时间线').left + 1,
      )
      expect(timeline!.right, `${at}: 时间线在详情右侧之前`).toBeLessThanOrEqual(
        must(inspector, '详情').left + 1,
      )
    }
  })

  test('icon rail in the middle band: the session list shrinks and a picker takes over', async ({ page }) => {
    await open(page, '#demo')
    for (const size of SIZES.filter(([width]) => width >= 1060 && width < 1279)) {
      await resize(page, size)
      const { sessions, narrowPicker, timeline, inspector } = await rects(page)
      const at = `${size[0]}px`
      expect(must(sessions, '会话列表').width, `${at}: 左栏收成图标条`).toBeLessThan(80)
      expect(narrowPicker, `${at}: 顶部出现会话下拉`).not.toBeNull()
      expect(must(timeline, '时间线').left, `${at}: 时间线接在图标条右侧`).toBeGreaterThan(sessions!.right)
      expect(timeline!.right, `${at}: 详情仍然常驻在右`).toBeLessThanOrEqual(must(inspector, '详情').left + 1)
    }
  })

  test('stacked on narrow screens: panels follow each other down the page', async ({ page }) => {
    await open(page, '#demo')
    for (const size of SIZES.filter(([width]) => width < 1000)) {
      await resize(page, size)
      const { sessions, timeline, inspector, findings } = await rects(page)
      const at = `${size[0]}px`
      expect(must(timeline, '时间线').top, `${at}: 时间线在会话列表下面`).toBeGreaterThanOrEqual(
        must(sessions, '会话列表').bottom - 1,
      )
      expect(must(inspector, '详情').top, `${at}: 详情在时间线下面`).toBeGreaterThanOrEqual(
        timeline!.bottom - 1,
      )
      expect(must(findings, '问题清单').top, `${at}: 问题清单在详情下面`).toBeGreaterThanOrEqual(
        inspector!.bottom - 1,
      )
      for (const [name, rect] of [
        ['会话列表', sessions],
        ['时间线', timeline],
        ['详情', inspector],
        ['问题清单', findings],
      ] as const) {
        expect(rect!.right, `${at}: ${name}不超出视口`).toBeLessThanOrEqual(size[0] + 0.5)
      }
    }
  })
})
