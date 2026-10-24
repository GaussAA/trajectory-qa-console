/** 同一份对比，三种产物（Markdown / HTML / JSON）要说同一件事。
 *  以及：英文报告里不该出现中文标点；导出的 HTML 报告同样守住 11px 的字号下限。 */

import { describe, expect, it } from 'vitest'
import { analyze, scoreSession } from '../core/analysis'
import type { AgentRun } from '../core/agent/types'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { renderAgentMarkdown } from './agent-report'
import { buildComparisonHtml } from './comparison-html'
import { buildHtmlReport } from './report-html'
import { buildComparisonJson, buildComparisonReport, buildMarkdownReport, type ReportEntry } from './report'

function entryOf(messages: unknown[], label: string): ReportEntry {
  const result = analyze({ source: JSON.stringify(messages), label, idPrefix: label })
  if (!result.ok) throw new Error(result.error.message)
  const session = result.value.sessions[0]
  if (!session) throw new Error('expected one session')
  return { trajectory: session.trajectory, card: scoreSession(session, DEFAULT_PACK) }
}

/** n 个来回；每个助手回复内容不同，这样对齐后每个助手步都是「changed」。
 *  用户消息两边相同，所以 n 个来回只有 n 个变化的步骤。 */
function conversation(tag: string, n: number): unknown[] {
  const steps: unknown[] = [{ role: 'system', content: 's' }]
  for (let i = 0; i < n; i += 1) {
    steps.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `${tag}-answer-${i}` })
  }
  return steps
}

const GENERATED = new Date('2026-10-22T12:00:00Z')

const MD_ROW = /^\| (changed|added|removed) /
const HTML_ROW = /<tr class="step-row st-(?!same)/g

describe('the step-diff cap means the same thing in every artifact', () => {
  const base = entryOf(conversation('old', 6), 'base.json')
  const target = entryOf(conversation('new', 6), 'target.json')

  it('Markdown and HTML both honour maxStepRows', () => {
    const input = { base, target, generatedAt: GENERATED, locale: 'en' as const, maxStepRows: 2 }
    const markdown = buildComparisonReport(input)
    const html = buildComparisonHtml(input)

    expect(markdown.split('\n').filter((line) => MD_ROW.test(line))).toHaveLength(2)
    // 之前 HTML 把上限写死成 40，maxStepRows 对它无效
    expect(html.match(HTML_ROW) ?? []).toHaveLength(2)
    expect(markdown).toContain('Showing the first 2 differences.')
    expect(html).toContain('Showing the first 2 differences.')
  })

  it('both default to the same cap when none is given', () => {
    // 45 个来回 → 45 个变化的助手步，超过默认的 40
    const input = {
      base: entryOf(conversation('old', 45), 'old.json'),
      target: entryOf(conversation('new', 45), 'new.json'),
      generatedAt: GENERATED,
      locale: 'en' as const,
    }
    expect(buildComparisonReport(input).split('\n').filter((line) => MD_ROW.test(line))).toHaveLength(40)
    expect(buildComparisonHtml(input).match(HTML_ROW) ?? []).toHaveLength(40)
  })

  it('JSON stays complete: it is for machines, and a silent cut would look like fewer changes', () => {
    const input = { base, target, generatedAt: GENERATED, locale: 'en' as const, maxStepRows: 2 }
    const json = JSON.parse(buildComparisonJson(input)) as { changedSteps: unknown[]; steps: { changed: number } }
    expect(json.changedSteps.length).toBeGreaterThan(2)
    expect(json.changedSteps.length).toBe(json.steps.changed)
  })

  it('the Markdown footer explains the scoring, like the HTML one, instead of repeating the findings summary', () => {
    const input = { base, target, generatedAt: GENERATED, locale: 'en' as const }
    const markdown = buildComparisonReport(input)
    const footer = markdown.slice(markdown.lastIndexOf('---'))
    expect(footer).toContain('Scoring:')
    // 「N new · N fixed · N remaining」只该在「问题变化」一节里出现一次，页脚不该再抄一遍
    expect(markdown.match(/\d+ new · \d+ fixed · \d+ remaining/g) ?? []).toHaveLength(1)
  })
})

describe('English reports carry no CJK punctuation of their own', () => {
  function twice() {
    // 同一规则命中 ≥2 次才会出「N×」
    return entryOf(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 's', arguments: '{"q":' } }] },
        { role: 'assistant', tool_calls: [{ id: 'b', function: { name: 's', arguments: '{"q":' } }] },
      ],
      'twice.json',
    )
  }

  it('the advice suffix uses ASCII parentheses', () => {
    const markdown = buildMarkdownReport({ entries: [twice()], pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'en' })
    const advice = markdown.slice(markdown.indexOf('### Recommendations'))
    expect(advice).toMatch(/ \(2×\)/)
    expect(advice).not.toMatch(/[（）]/)
  })

  it('the Chinese report keeps its fullwidth parentheses', () => {
    const markdown = buildMarkdownReport({ entries: [twice()], pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' })
    expect(markdown).toMatch(/（2 处）/)
  })

  function agentRun(): AgentRun {
    return {
      ok: true,
      answer: '',
      diagnosis: {
        verdict: 'v',
        rootCauses: [{ session: 's', cause: 'c', evidence: 'e' }],
        actions: [{ action: 'a', rationale: 'r' }],
      },
      proposals: [],
      trace: { entries: [], toolCalls: 0, rounds: 1, truncated: false, stopReason: 'submitted' },
      usage: { prompt: 1, completion: 1 },
    } as unknown as AgentRun
  }

  const agentBase = () => ({
    run: agentRun(),
    model: 'm',
    endpoint: 'https://llm.example/v1',
    pack: DEFAULT_PACK,
    sessions: [],
    generatedAt: GENERATED,
  })

  it('the agent report uses ASCII punctuation in English', () => {
    const en = renderAgentMarkdown({ ...agentBase(), locale: 'en' })
    expect(en).not.toMatch(/[：（）]/)
    expect(en).toContain('Rounds: 1')
    expect(en).toContain('Evidence: e')
    expect(en).toMatch(/Tokens: 2 \(1 in \/ 1 out\)/)
  })

  it('the agent report keeps fullwidth punctuation in Chinese', () => {
    const zh = renderAgentMarkdown({ ...agentBase(), locale: 'zh-CN' })
    expect(zh).toContain('轮次：1')
    expect(zh).toContain('证据：e')
    expect(zh).toMatch(/token：2（输入 1 \/ 输出 1）/)
  })
})

describe('exported report styles keep the 11px floor', () => {
  /** 取一份完整导出的 HTML 里所有 font-size 声明，px 与 pt 都换成 px。 */
  function sizesIn(html: string): { raw: string; px: number }[] {
    return [...html.matchAll(/font-size\s*:\s*([0-9.]+)(px|pt)/g)].map((m) => ({
      raw: `${m[1]}${m[2]}`,
      px: m[2] === 'pt' ? Number(m[1]) * (4 / 3) : Number(m[1]),
    }))
  }

  const entry = entryOf(conversation('x', 2), 'x.json')
  const documents = {
    'session report': buildHtmlReport({ entries: [entry], pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' }),
    'comparison report': buildComparisonHtml({
      base: entry,
      target: entryOf(conversation('y', 2), 'y.json'),
      generatedAt: GENERATED,
      locale: 'zh-CN',
    }),
  }

  it.each(Object.entries(documents))('declares no font size below 11px in the %s', (_name, html) => {
    const sizes = sizesIn(html)
    expect(sizes.length).toBeGreaterThan(0)
    for (const size of sizes) expect(size.px, size.raw).toBeGreaterThanOrEqual(11)
  })
})
