import { describe, expect, it } from 'vitest'
import { parseTrajectory } from '../core/parsing'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { runRules } from '../core/rules/engine'
import { scoreTrajectory } from '../core/analysis/score'
import { buildHtmlReport } from './report-html'
import {
  buildComparisonJson,
  buildComparisonReport,
  buildJsonReport,
  buildMarkdownReport,
  reportTotals,
} from './report'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }],
  },
])

describe('report builders', () => {
  const parsed = parseTrajectory(TRACE, 'trace.json')
  if (!parsed.ok) throw new Error(parsed.error.message)
  const trajectory = parsed.value[0]
  if (!trajectory) throw new Error('fixture did not parse')
  const { findings, ruleIssues } = runRules(trajectory, DEFAULT_PACK)
  const card = scoreTrajectory(findings, DEFAULT_PACK.dimensions, ruleIssues)
  const entries = [{ trajectory, card }]

  it('gives the markdown and html artifacts the very same totals', () => {
    const input = {
      entries,
      pack: DEFAULT_PACK,
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'zh-CN' as const,
    }
    const totals = reportTotals(entries, DEFAULT_PACK)
    const markdown = buildMarkdownReport(input)
    const html = buildHtmlReport(input)

    // Both artifacts must print the numbers produced by reportTotals — they
    // used to run their own reduce, agreeing only by luck.
    for (const value of [totals.sessions, totals.steps, totals.average]) {
      expect(markdown).toContain(String(value))
      expect(html).toContain(String(value))
    }
    expect(totals.enabledRules).toBe(DEFAULT_PACK.rules.filter((rule) => rule.enabled !== false).length)
  })

  it('writes a markdown report with overview, scores and findings', () => {
    const markdown = buildMarkdownReport({
      entries,
      pack: DEFAULT_PACK,
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'zh-CN',
    })
    expect(markdown).toContain('# 轨迹质检报告')
    expect(markdown).toContain('| 会话 | 步骤 | token | 总分 |')
    expect(markdown).toContain('trace.json')
    expect(markdown).toContain('### 问题清单')
    expect(markdown).toContain('工具参数非法 JSON')
    expect(markdown).toContain('评分口径')
    // 有映射的规则才出建议，且不标「1 处」
    expect(markdown).toContain('### 建议')
    expect(markdown).toContain('调用前做参数 schema 校验')
    expect(markdown).not.toContain('（1 处）')
  })

  it('prints the same labelled totals in markdown, html and json, even with a disabled rule', () => {
    // 停用两条规则：规则总数 ≠ 启用数，两个数字才分得清谁是谁。
    const disabled = new Set(DEFAULT_PACK.rules.slice(0, 2).map((rule) => rule.id))
    const pack = {
      ...DEFAULT_PACK,
      rules: DEFAULT_PACK.rules.map((rule) => (disabled.has(rule.id) ? { ...rule, enabled: false } : rule)),
    }
    const input = { entries, pack, generatedAt: new Date('2026-10-22T12:00:00Z'), locale: 'zh-CN' as const }
    const totals = reportTotals(entries, pack)
    expect(totals.enabledRules).toBe(DEFAULT_PACK.rules.length - 2)

    const markdown = buildMarkdownReport(input)
    const html = buildHtmlReport(input)
    const json = JSON.parse(buildJsonReport(input))

    // 按带标签的整句断言，而不是找一个数字：单个数字出现在报告里任何地方都能蒙混过关。
    const rulePackLine = `规则包：${pack.name}（${totals.enabledRules} 条启用）`
    expect(markdown).toContain(rulePackLine)
    expect(html).toContain(rulePackLine)
    expect(markdown).toContain(`会话数：${totals.sessions}`)
    expect(markdown).toContain(`总步数：${totals.steps}`)
    expect(markdown).toContain(`平均分：${totals.average}`)

    // JSON 是同一份 reportTotals，键名稳定。
    expect(json.totals).toEqual(totals)
    expect(json.rulePack.enabledRules).toBe(totals.enabledRules)
    // `rules` 仍是规则总数（含停用的）：这个键名是 CI 的契约，含义不改。
    expect(json.rulePack.rules).toBe(DEFAULT_PACK.rules.length)
    expect(json.rulePack.rules).not.toBe(json.rulePack.enabledRules)
  })

  it('writes a machine-readable json report', () => {
    const json = JSON.parse(
      buildJsonReport({
        entries,
        pack: DEFAULT_PACK,
        generatedAt: new Date('2026-10-22T12:00:00Z'),
        locale: 'zh-CN',
      }),
    )
    expect(json.sessions).toHaveLength(1)
    expect(json.sessions[0].score).toBe(card.overall)
    expect(json.sessions[0].findings.length).toBeGreaterThan(0)
    expect(json.rulePack.rules).toBe(DEFAULT_PACK.rules.length)
  })

  it('localizes the whole markdown report for English', () => {
    const markdown = buildMarkdownReport({
      entries,
      pack: DEFAULT_PACK,
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'en',
    })
    expect(markdown).toContain('# Trajectory QA Report')
    expect(markdown).toContain('| Session | Steps | tokens | Score | Grade |')
    expect(markdown).toContain('### Findings')
    expect(markdown).toContain('Scoring:')

    // Rule titles/messages are rule-pack data and stay Chinese on purpose, so
    // only the chrome — everything before the findings list plus the footer —
    // must be CJK-free.
    const chrome = markdown.slice(0, markdown.indexOf('### Findings')).split('\n')
    const chineseLines = chrome.filter((line) => /[\u4e00-\u9fff]/.test(line))
    // The only Chinese left in the chrome is the rule-pack name — also data.
    expect(chineseLines).toHaveLength(1)
    expect(chineseLines[0]).toContain(DEFAULT_PACK.name)
    expect(markdown.slice(markdown.lastIndexOf('\n---\n'))).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('keeps json keys stable but localizes readable labels', () => {
    const zh = JSON.parse(
      buildJsonReport({
        entries,
        pack: DEFAULT_PACK,
        generatedAt: new Date('2026-10-22T12:00:00Z'),
        locale: 'zh-CN',
      }),
    )
    const en = JSON.parse(
      buildJsonReport({
        entries,
        pack: DEFAULT_PACK,
        generatedAt: new Date('2026-10-22T12:00:00Z'),
        locale: 'en',
      }),
    )

    // Machine contract: identical shape, only label values differ.
    expect(Object.keys(en.sessions[0]).sort()).toEqual(Object.keys(zh.sessions[0]).sort())
    expect(en.sessions[0].dimensions[0].id).toBe(zh.sessions[0].dimensions[0].id)
    expect(zh.sessions[0].dimensions[0].label).toBe('结构合法性')
    expect(en.sessions[0].dimensions[0].label).toBe('Structure')
    expect(en.locale).toBe('en')
  })

  it('builds a comparison report with score, dimension and step tables', () => {
    const clean = parseTrajectory(
      JSON.stringify([
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '查一下' },
        { role: 'assistant', content: '好的' },
      ]),
      'clean.json',
    )
    if (!clean.ok) throw new Error(clean.error.message)
    const cleanTrajectory = clean.value[0] as NonNullable<(typeof clean.value)[0]>
    const cleanRun = runRules(cleanTrajectory, DEFAULT_PACK)
    const cleanCard = scoreTrajectory(cleanRun.findings, DEFAULT_PACK.dimensions, cleanRun.ruleIssues)

    const input = {
      base: { trajectory: cleanTrajectory, card: cleanCard },
      target: entries[0] as (typeof entries)[number],
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'zh-CN' as const,
    }
    const markdown = buildComparisonReport(input)

    expect(markdown).toContain('# 轨迹对比报告')
    expect(markdown).toContain('| 项目 | 基准 | 对照 | 变化 |')
    expect(markdown).toContain('| 维度 | 基准 | 对照 | 变化 |')
    expect(markdown).toContain('## 步骤差异')
    expect(markdown).toContain('| 状态 | 基准步 | 对照步 | 基准内容 | 对照内容 |')
    // 等级行不该显示分数差
    expect(markdown).toMatch(/\| 等级 \| [A-E] \| [A-E] \| — \|/)
  })

  it('localizes the comparison report and caps the step table', () => {
    const input = {
      base: entries[0] as (typeof entries)[number],
      target: entries[0] as (typeof entries)[number],
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'en' as const,
      maxStepRows: 1,
    }
    const markdown = buildComparisonReport(input)
    expect(markdown).toContain('# Trajectory Comparison')
    expect(markdown).toContain('| Item | Baseline | Candidate | Delta |')
    expect(markdown).toContain('The two traces are identical.')
  })

  it('emits a machine-readable comparison', () => {
    const input = {
      base: entries[0] as (typeof entries)[number],
      target: entries[0] as (typeof entries)[number],
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'zh-CN' as const,
    }
    const json = JSON.parse(buildComparisonJson(input))
    expect(json.score.overall.delta).toBe(0)
    expect(json.findings.added).toBe(0)
    expect(json.base.label).toBe('trace.json')
  })
})
