import { describe, expect, it } from 'vitest'
import { scoreTrajectory } from '../core/analysis/score'
import { parseTrajectory } from '../core/parsing'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { runRules } from '../core/rules/engine'
import { buildHtmlReport } from './report-html'
import { escapeHtml } from './report-style'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }],
  },
])

function entriesOf(text: string, label = 'trace.json') {
  const parsed = parseTrajectory(text, label)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.map((trajectory) => {
    const { findings, ruleIssues } = runRules(trajectory, DEFAULT_PACK)
    return { trajectory, card: scoreTrajectory(findings, DEFAULT_PACK.dimensions, ruleIssues) }
  })
}

const GENERATED = new Date('2026-10-22T12:00:00Z')

const HEALTHY = JSON.stringify([
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好，有什么可以帮你？' },
])

/** 取第 n 个会话的 <details> 开始标签；找不到就让测试直接失败。 */
function sessionTag(html: string, n: number): string {
  const match = html.match(new RegExp(`<details\\b[^>]*\\bid="session-${n}"[^>]*>`))
  if (!match) throw new Error(`no <details> for session ${n}`)
  return match[0]
}

const isOpen = (tag: string) => /\sopen(?=[\s>=])/.test(tag)

describe('buildHtmlReport', () => {
  const entries = entriesOf(TRACE)

  it('produces a complete, self-contained document', () => {
    const html = buildHtmlReport({ entries, pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' })

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8" />')
    expect(html).toContain('轨迹质检报告')
    expect(html).toContain('<style>')

    // 自包含与零脚本：报告要能拷到任何机器上打开。
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(["']?https?:/i)
  })

  it('renders overview, dimensions, findings and advice', () => {
    const html = buildHtmlReport({ entries, pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' })

    expect(html).toContain('总览')
    expect(html).toContain('trace.json')
    // 维度条与分数
    expect(html).toContain('结构合法性')
    expect(html).toContain('class="dim-bar"')
    // 问题清单与建议
    expect(html).toContain('工具参数非法 JSON')
    expect(html).toContain('问题清单')
    expect(html).toContain('建议')
    // 分数环用自定义属性驱动，避免内联渐变字符串
    expect(html).toContain('--pct:')
  })

  it('marks the score ring with the grade tone', () => {
    const html = buildHtmlReport({ entries, pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' })
    const score = entries[0]?.card.overall ?? 0
    const expected = score >= 90 ? '#5eead4' : score >= 75 ? '#34d399' : score >= 60 ? '#fbbf24' : '#fb7185'
    expect(html).toContain(`--tone:${expected}`)
  })

  it('escapes every piece of external text', () => {
    const injected = [
      { role: 'system', content: '<script>alert(1)</script>' },
      { role: 'user', content: 'a & b "quoted" <b>' },
      // 工具名会进「证据」摘录，是另一条外部数据通道，必须一并转义。
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: '<b onclick=x>', arguments: '{"q":' } }],
      },
    ]
    const html = buildHtmlReport({
      entries: entriesOf(JSON.stringify(injected), 'evil<img src=x onerror=1>.json'),
      pack: DEFAULT_PACK,
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b onclick=x>')
    expect(html).toContain('evil&lt;img src=x onerror=1&gt;.json')
    expect(html).toContain('&lt;b onclick=x&gt;')
  })

  it('localizes headings and the lang attribute', () => {
    const html = buildHtmlReport({ entries, pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'en' })

    expect(html).toContain('<html lang="en">')
    expect(html).toContain('Trajectory QA Report')
    expect(html).toContain('Overview')
    expect(html).toContain('Findings')
    // 维度名走 labelFor，英文界面下是英文
    expect(html).toContain('Structure')
    // 规则标题属数据，保持中文（与 ADR-0006 一致）
    expect(html).toContain('工具参数非法 JSON')
  })

  describe('navigating a long report', () => {
    // 两个会话故意同名：锚点 id 必须来自序号，不能来自（外部的、可能重复的）轨迹名。
    const mixed = [...entriesOf(TRACE, 'same.json'), ...entriesOf(HEALTHY, 'same.json')]
    const html = buildHtmlReport({
      entries: mixed,
      pack: DEFAULT_PACK,
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    it('links every overview row to its own session, even when names repeat', () => {
      expect(html).toContain('<a href="#session-1">same.json</a>')
      expect(html).toContain('<a href="#session-2">same.json</a>')

      const ids = [...html.matchAll(/<details\b[^>]*\bid="(session-\d+)"/g)].map((match) => match[1])
      expect(ids).toEqual(['session-1', 'session-2'])
    })

    it('opens only the sessions that have error-level findings', () => {
      // 夹具必须一好一坏，否则下面的断言是空转。
      expect(mixed[0]?.card.counts.error).toBeGreaterThan(0)
      expect(mixed[1]?.card.counts.error).toBe(0)

      expect(isOpen(sessionTag(html, 1))).toBe(true)
      expect(isOpen(sessionTag(html, 2))).toBe(false)
    })

    it('keeps the name, score and grade visible in the fold header', () => {
      const summaries = [...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(
        (match) => match[1] ?? '',
      )
      expect(summaries).toHaveLength(2)
      summaries.forEach((summary, index) => {
        const card = mixed[index]?.card
        expect(summary).toContain('same.json')
        expect(summary).toContain(`>${card?.overall}<`)
        expect(summary).toContain(card?.grade ?? '')
      })
    })

    it('shows every session when printed and when jumped to, without a script', () => {
      // 两条规则必须各自独立：选择器列表里只要有一个浏览器不认识，整条规则就会被丢掉。
      expect(html).toMatch(/details:target::details-content\s*\{[^}]*content-visibility:\s*visible/)
      expect(html).toMatch(
        /@media print\s*\{[\s\S]*details::details-content\s*\{[^}]*content-visibility:\s*visible/,
      )
      expect(html).not.toMatch(/<script/i)
    })
  })

  it('handles an empty workspace without throwing', () => {
    const html = buildHtmlReport({ entries: [], pack: DEFAULT_PACK, generatedAt: GENERATED, locale: 'zh-CN' })
    expect(html).toContain('轨迹质检报告')
    expect(html).toContain('<tbody>')
  })
})

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('第 3 步 · search_kb')).toBe('第 3 步 · search_kb')
  })
})
