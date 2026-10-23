import { describe, expect, it } from 'vitest'
import { scoreTrajectory } from '../core/analysis/score'
import { parseTrajectory } from '../core/parsing'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { runRules } from '../core/rules/engine'
import { buildComparisonHtml } from './comparison-html'
import type { ReportEntry } from './report'

function entryOf(text: string, label: string): ReportEntry {
  const parsed = parseTrajectory(text, label)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const trajectory = parsed.value[0]
  if (!trajectory) throw new Error('fixture did not parse')
  const { findings, ruleIssues } = runRules(trajectory, DEFAULT_PACK)
  return { trajectory, card: scoreTrajectory(findings, DEFAULT_PACK.dimensions, ruleIssues) }
}

const CLEAN = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', content: '好的' },
])

const BROKEN = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

const GENERATED = new Date('2026-10-22T12:00:00Z')

describe('buildComparisonHtml', () => {
  const base = entryOf(CLEAN, 'a-clean.json')
  const target = entryOf(BROKEN, 'b-broken.json')

  it('produces a self-contained document with both score rings', () => {
    const html = buildComparisonHtml({
      base,
      target,
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('轨迹对比报告')

    // 自包含与零脚本，与逐会话报告同一契约
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(html).not.toMatch(/@import/i)

    // 两个分数环 + 差值徽章
    expect(html.match(/class="score"/g)?.length).toBe(2)
    expect(html).toMatch(/class="delta-badge (up|down|flat)"/)
  })

  it('renders dimensions, finding changes, advice and step rows', () => {
    const html = buildComparisonHtml({ base, target, generatedAt: GENERATED, locale: 'zh-CN' })

    expect(html).toContain('维度')
    expect(html).toContain('问题变化')
    expect(html).toContain('新增问题')
    // 基准没有的问题在对照里出现 → 有新增，也就有建议
    expect(html).toContain('对照改进建议')
    expect(html).toContain('st-added')
    expect(html).toContain('st-removed')
    // 状态徽章文案来自 compare.status.*
    expect(html).toContain('新增步')
  })

  it('escapes external labels and content', () => {
    const evil = entryOf(CLEAN, 'evil<img src=x onerror=1>.json')
    const html = buildComparisonHtml({
      base: evil,
      target,
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('evil&lt;img src=x onerror=1&gt;.json')
  })

  it('localizes chrome but keeps rule titles as data', () => {
    const html = buildComparisonHtml({ base, target, generatedAt: GENERATED, locale: 'en' })

    expect(html).toContain('<html lang="en">')
    expect(html).toContain('Trajectory Comparison')
    expect(html).toContain('New findings')
    expect(html).toContain('added')
    // 规则标题属数据（ADR-0006），英文界面下保持中文
    expect(html).toContain('工具参数非法 JSON')
  })

  it('says so when the two traces are identical', () => {
    const html = buildComparisonHtml({
      base,
      target: entryOf(CLEAN, 'a-clean.json'),
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    expect(html).toContain('两条轨迹没有差异')
    // `st-added` 会出现在样式表里，只断言步骤行里没有差异行
    expect(html).not.toContain('class="step-row st-')
    expect(html).toMatch(/class="delta-badge flat"/)
  })
})
