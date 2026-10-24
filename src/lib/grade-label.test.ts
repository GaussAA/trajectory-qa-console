/** 等级标签在每一种出口都要说实话：界面、Markdown、JSON、HTML 同一个口径。 */

import { describe, expect, it } from 'vitest'
import { analyze, scoreSession } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { SAMPLE_FILES } from '../core/sample'
import { buildHtmlReport } from './report-html'
import { buildJsonReport, buildMarkdownReport, type ReportEntry } from './report'

const GENERATED = new Date('2026-10-22T12:00:00Z')

function entryOf(source: string, label: string): ReportEntry {
  const result = analyze({ source, label, idPrefix: label })
  if (!result.ok) throw new Error(result.error.message)
  const session = result.value.sessions[0]
  if (!session) throw new Error('expected one session')
  return { trajectory: session.trajectory, card: scoreSession(session, DEFAULT_PACK) }
}

/** 示例里那条被封顶在 74 的死循环轨迹：原始分 89，封顶后 74，等级 C。 */
function cappedSample(): ReportEntry {
  for (const sample of SAMPLE_FILES) {
    const entry = entryOf(sample.content, sample.name)
    if (entry.card.capped && entry.card.grade === 'C') return entry
  }
  throw new Error('no capped C sample found')
}

const CLEAN = JSON.stringify([
  { role: 'system', content: 's' },
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a' },
])

const input = (entry: ReportEntry, locale: 'zh-CN' | 'en') => ({
  entries: [entry],
  pack: DEFAULT_PACK,
  generatedAt: GENERATED,
  locale,
})

describe('a capped C no longer reads as acceptable', () => {
  const sample = cappedSample()

  it('the premise: the sample really is 74 / C with an error finding', () => {
    expect(sample.card.overall).toBe(74)
    expect(sample.card.grade).toBe('C')
    expect(sample.card.counts.error).toBeGreaterThan(0)
  })

  it('Markdown says so in Chinese and in English', () => {
    const zh = buildMarkdownReport(input(sample, 'zh-CN'))
    const en = buildMarkdownReport(input(sample, 'en'))
    expect(zh).toContain('C · 有严重问题')
    expect(zh).not.toContain('C · 合格')
    expect(en).toContain('C · Serious issues')
    expect(en).not.toContain('C · Pass')
  })

  it('HTML says so too', () => {
    const zh = buildHtmlReport(input(sample, 'zh-CN'))
    const en = buildHtmlReport(input(sample, 'en'))
    expect(zh).toContain('C · 有严重问题')
    expect(en).toContain('C · Serious issues')
  })

  it('JSON keeps the machine-readable letter and only changes the readable label', () => {
    const zh = JSON.parse(buildJsonReport(input(sample, 'zh-CN'))) as { sessions: { grade: string; gradeLabel: string }[] }
    const en = JSON.parse(buildJsonReport(input(sample, 'en'))) as { sessions: { grade: string; gradeLabel: string }[] }
    // 给 CI 解析的键与值不变
    expect(zh.sessions[0]?.grade).toBe('C')
    expect(en.sessions[0]?.grade).toBe('C')
    expect(zh.sessions[0]?.gradeLabel).toBe('有严重问题')
    expect(en.sessions[0]?.gradeLabel).toBe('Serious issues')
  })
})

describe('everything else keeps its label', () => {
  it('a clean trace is still Excellent', () => {
    const clean = entryOf(CLEAN, 'clean.json')
    expect(buildMarkdownReport(input(clean, 'zh-CN'))).toContain('A · 优秀')
    expect(buildMarkdownReport(input(clean, 'en'))).toContain('A · Excellent')
  })
})
