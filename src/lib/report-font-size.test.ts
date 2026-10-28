import { describe, expect, it } from 'vitest'
import { scoreTrajectory } from '../core/analysis/score'
import { parseTrajectory } from '../core/parsing'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { runRules } from '../core/rules/engine'
import { buildComparisonHtml } from './comparison-html'
import { buildHtmlReport } from './report-html'
import type { ReportEntry } from './report'

const FLOOR_PX = 11

function entryOf(text: string, label: string): ReportEntry {
  const parsed = parseTrajectory(text, label)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const trajectory = parsed.value[0]
  if (!trajectory) throw new Error('fixture did not parse')
  const { findings, ruleIssues } = runRules(trajectory, DEFAULT_PACK)
  return { trajectory, card: scoreTrajectory(findings, DEFAULT_PACK.dimensions, ruleIssues) }
}

const CLEAN = JSON.stringify([
  { role: 'user', content: '查一下' },
  { role: 'assistant', content: '好的' },
])
const BROKEN = JSON.stringify([
  { role: 'user', content: '查一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

const GENERATED = new Date('2026-10-22T12:00:00Z')
const base = entryOf(CLEAN, 'a.json')
const target = entryOf(BROKEN, 'b.json')

const reports: [string, string][] = [
  [
    'single report',
    buildHtmlReport({ entries: [base, target], pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' }),
  ],
  ['comparison report', buildComparisonHtml({ base, target, generatedAt: GENERATED, locale: 'zh-CN' })],
]

/** 内嵌 <style> 里每一条 font-size 声明的值（去掉首尾空白）。 */
function fontSizes(html: string): string[] {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  return [...style.matchAll(/font-size\s*:\s*([^;}\n]+)/g)].map((match) => (match[1] ?? '').trim())
}

describe.each(reports)('embedded font sizes in the %s', (_name, html) => {
  const sizes = fontSizes(html)

  it('has font sizes to check, so the assertions below are not vacuous', () => {
    expect(sizes.length).toBeGreaterThan(10)
  })

  it('only uses real lengths, never a half-substituted value', () => {
    // 浏览器会丢掉非法值，元素静默退回继承的 14px；这里把它当成错误。
    expect(sizes.filter((size) => !/^[0-9]+(\.[0-9]+)?(px|pt)$/.test(size))).toEqual([])
  })

  it('never goes below the 11px floor', () => {
    const tooSmall = sizes.filter((size) => {
      const match = size.match(/^([0-9.]+)(px|pt)$/)
      if (!match) return false
      const px = match[2] === 'pt' ? Number(match[1]) * (4 / 3) : Number(match[1])
      return px < FLOOR_PX
    })
    expect(tooSmall).toEqual([])
  })
})
