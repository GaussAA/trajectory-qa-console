/** 真实流水线上的同一件事：改 prompt 后，在最前面多出一个步骤，其余原样。
 *  对比报告的「问题变化」不该出现一长串假的增删。三种产物和面板用的是同一份 buildComparisonModel。 */

import { describe, expect, it } from 'vitest'
import { analyze, scoreSession } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { buildComparisonHtml } from './comparison-html'
import { buildComparisonJson, buildComparisonReport, type ReportEntry } from './report'

function entryOf(messages: unknown[], label: string): ReportEntry {
  const result = analyze({ source: JSON.stringify(messages), label, idPrefix: label })
  if (!result.ok) throw new Error(result.error.message)
  const session = result.value.sessions[0]
  if (!session) throw new Error('expected one session')
  return { trajectory: session.trajectory, card: scoreSession(session, DEFAULT_PACK) }
}

/** 两次调用都带非法 JSON 的参数 → 两条 structure-invalid-args（各在自己的步上）。 */
const TAIL = [
  { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'write', arguments: '{"x":' } }] },
  { role: 'tool', tool_call_id: 'a', content: 'ok' },
  { role: 'assistant', tool_calls: [{ id: 'b', function: { name: 'save', arguments: '{"y":' } }] },
  { role: 'tool', tool_call_id: 'b', content: 'ok' },
  { role: 'assistant', content: 'done' },
]

const BASE = entryOf([{ role: 'system', content: 's' }, { role: 'user', content: 'q' }, ...TAIL], 'base.json')
// 在 user 之后多出一个纯文本的助手步骤：后面所有步号 +1，问题本身一个没变
const TARGET = entryOf(
  [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '先想一想' },
    ...TAIL,
  ],
  'target.json',
)
const GENERATED = new Date('2026-10-22T12:00:00Z')
const input = (locale: 'zh-CN' | 'en') => ({ base: BASE, target: TARGET, generatedAt: GENERATED, locale })

describe('the premise', () => {
  it('both sides carry the same two invalid-argument findings, shifted by one step', () => {
    const steps = (entry: ReportEntry) =>
      entry.card.findings.filter((f) => f.ruleId === 'structure-invalid-args').map((f) => f.stepIndex)
    expect(steps(BASE)).toHaveLength(2)
    expect(steps(TARGET)).toHaveLength(2)
    expect(steps(TARGET)).toEqual(steps(BASE).map((index) => (index ?? 0) + 1))
  })
})

describe('an inserted step does not fabricate finding changes in any artifact', () => {
  it('JSON: nothing added, nothing resolved, the same findings persisted', () => {
    const json = JSON.parse(buildComparisonJson(input('zh-CN'))) as {
      findings: { added: number; resolved: number; persisted: number; changed: number }
    }
    const invalid = (n: number) => n
    expect(json.findings.added).toBe(0)
    expect(json.findings.resolved).toBe(0)
    expect(invalid(json.findings.persisted)).toBeGreaterThanOrEqual(2)
    expect(json.findings.changed).toBe(0)
  })

  it('Markdown: no added or resolved sections, and the summary says 0 new · 0 fixed', () => {
    const markdown = buildComparisonReport(input('en'))
    expect(markdown).toMatch(/0 new · 0 fixed · \d+ remaining/)
    expect(markdown).not.toContain('### New findings')
    expect(markdown).not.toContain('### Fixed findings')
  })

  it('HTML: same', () => {
    const html = buildComparisonHtml(input('en'))
    expect(html).toMatch(/0 new · 0 fixed · \d+ remaining/)
    expect(html).not.toContain('New findings')
    expect(html).not.toContain('Fixed findings')
  })
})

describe('a problem that really changed is still reported', () => {
  it('a newly broken call after the inserted step shows up as new', () => {
    const worse = entryOf(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '先想一想' },
        ...TAIL,
        { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'extra', arguments: '{"z":' } }] },
      ],
      'worse.json',
    )
    const json = JSON.parse(buildComparisonJson({ base: BASE, target: worse, generatedAt: GENERATED, locale: 'zh-CN' })) as {
      findings: { added: number }
    }
    expect(json.findings.added).toBeGreaterThan(0)
  })

  it('a fixed call after the inserted step shows up as resolved', () => {
    const fixed = entryOf(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '先想一想' },
        { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'write', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'a', content: 'ok' },
        TAIL[2],
        TAIL[3],
        TAIL[4],
      ],
      'fixed.json',
    )
    const json = JSON.parse(buildComparisonJson({ base: BASE, target: fixed, generatedAt: GENERATED, locale: 'zh-CN' })) as {
      findings: { resolved: number; added: number }
    }
    expect(json.findings.resolved).toBeGreaterThan(0)
    expect(json.findings.added).toBe(0)
  })
})
