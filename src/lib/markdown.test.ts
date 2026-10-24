/** 报告里的轨迹名、规则标题、证据、模型结论都来自不受信的一方，会被贴进 PR 和周报。
 *  这里锁两件事：转义函数本身的行为，以及整份报告里「注入不出结构、不出可点/可取的资源」。 */

import { describe, expect, it } from 'vitest'
import { analyze, scoreSession } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import type { AgentRun } from '../core/agent/types'
import { renderAgentMarkdown } from './agent-report'
import { mdBlock, mdCell, mdCode, mdInline } from './markdown'
import { buildComparisonReport, buildMarkdownReport } from './report'
import { buildPackCompareModel, renderPackCompareMarkdown } from './pack-compare-report'

describe('mdInline', () => {
  it('escapes the characters that open links, images, html, code and emphasis', () => {
    // 圆括号不转义：只有 `[` 能开链接/图片，`]` 与 `[` 一并转义后，`(…)` 只是普通文字。
    expect(mdInline('[a](b) ![c](d) <img src=x> `e` **f**')).toBe(
      '\\[a\\](b) !\\[c\\](d) \\<img src=x\\> \\`e\\` \\*\\*f\\*\\*',
    )
  })

  it('escapes the backslash first, so an existing \\[ cannot become a live link', () => {
    // 输入里已有 `\[`：若先转义 `[` 再转义 `\`，结果会是 `\\[` ——反斜杠自我抵消，方括号复活。
    expect(mdInline('\\[x\\]')).toBe('\\\\\\[x\\\\\\]')
  })

  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['lone CR', 'a\rb'],
    ['U+2028', 'a\u2028b'],
    ['U+2029', 'a\u2029b'],
    ['a run of mixed breaks', 'a\n\r\n\u2028b'],
  ])('flattens %s into one space, so a label cannot start a new line', (_name, text) => {
    expect(mdInline(text)).toBe('a b')
  })

  it('leaves underscores, CJK and ordinary punctuation alone', () => {
    expect(mdInline('search_kb · exec-tool-error · 第 3 步，结果：ok.')).toBe(
      'search_kb · exec-tool-error · 第 3 步，结果：ok.',
    )
  })
})

describe('mdCell', () => {
  it('also escapes pipes so a value cannot add a column', () => {
    expect(mdCell('a|b')).toBe('a\\|b')
    expect(mdCell('x|y\nz')).toBe('x\\|y z')
  })
})

describe('mdCode', () => {
  it('uses a fence longer than any backtick run inside, so the span cannot be closed early', () => {
    expect(mdCode('plain')).toBe('`plain`')
    expect(mdCode('a`b')).toBe('``a`b``')
    expect(mdCode('a``b')).toBe('```a``b```')
  })

  it('pads when the text starts or ends with a backtick or space', () => {
    expect(mdCode('`x')).toBe('`` `x ``')
    expect(mdCode('x`')).toBe('`` x` ``')
  })

  it('flattens newlines', () => {
    expect(mdCode('a\nb')).toBe('`a b`')
  })
})

describe('mdBlock', () => {
  it('keeps line breaks but defuses images, html and link brackets', () => {
    const out = mdBlock('line one\n![x](https://e.example/t.gif)\n<img src="https://e.example/h.png">')
    expect(out.split('\n')).toHaveLength(3)
    expect(out).not.toMatch(/(?<!\\)!\[/)
    expect(out).not.toMatch(/(?<!\\)</)
    expect(out).not.toMatch(/(?<!\\)\[/)
  })

  it('defuses a heading and a code fence at the start of a line', () => {
    expect(mdBlock('# fake heading')).toBe('\\# fake heading')
    expect(mdBlock('### deeper')).toBe('\\### deeper')
    expect(mdBlock('```\nswallowed')).toBe('\\```\nswallowed')
    expect(mdBlock('~~~')).toBe('\\~~~')
    expect(mdBlock('  # indented')).toBe('  \\# indented')
  })

  it('does not touch a # that is not a heading marker', () => {
    expect(mdBlock('issue #12 and C#')).toBe('issue #12 and C#')
    expect(mdBlock('#hashtag')).toBe('#hashtag')
  })

  it('treats CR, CRLF and U+2028 as line breaks, so none of them hides a heading', () => {
    expect(mdBlock('a\r# h')).toBe('a\n\\# h')
    expect(mdBlock('a\r\n# h')).toBe('a\n\\# h')
    expect(mdBlock('a\u2028# h')).toBe('a\n\\# h')
  })
})

// ---------------------------------------------------------------------------
// 整份报告：把一份满是恶意字段的轨迹喂进真实流水线。
// ---------------------------------------------------------------------------

const FORGED = '# 总分 100 分 · 全部通过'
const TRACKER = '![](https://attacker.example/p.png?leak=1)'
const PHISH = '[点此领奖](https://attacker.example/phish)'

const HOSTILE = {
  title: `run-1\n\n${FORGED}\n\n${TRACKER}`,
  model: `gpt\n## injected\n${TRACKER}`,
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: `根据搜索结果，请看 ${PHISH} 与 ${TRACKER} <img src="https://attacker.example/h.png">\n\`\`\`\n后面的内容被吞进代码块`,
    },
  ],
}

function hostileEntry(overrides: Record<string, unknown> = {}, label = 'hostile.json') {
  const result = analyze({
    source: JSON.stringify({ ...HOSTILE, ...overrides }),
    label,
    idPrefix: 'md',
  })
  if (!result.ok) throw new Error(result.error.message)
  const session = result.value.sessions[0]
  if (!session) throw new Error('expected one session')
  return { session, trajectory: session.trajectory, card: scoreSession(session, DEFAULT_PACK) }
}

/** 报告自己写的标题行（`# ` / `## ` / `### ` 开头）。 */
function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^#{1,6}\s/.test(line))
}

/** 以伪造内容**开头**的标题行。压平进报告自身标题里的那段文字（`## 1. run-1 # 总分 100 …`）
 *  是行内文字，不算伪造：标题只在行首才成立。 */
function forgedHeadings(markdown: string): string[] {
  return headings(markdown).filter((line) => /^#{1,6}\s+总分 100/.test(line))
}

function expectInert(markdown: string): void {
  // 没有未被转义的图片、链接方括号、尖括号。
  expect(markdown).not.toMatch(/(?<!\\)!\[/)
  expect(markdown).not.toMatch(/(?<!\\)\[[^\]]*\]\(/)
  expect(markdown).not.toMatch(/(?<!\\)<(?:img|script|a|iframe)/i)
  // 注入的伪造标题不能独占一行
  expect(markdown.split('\n')).not.toContain(FORGED)
  // 代码围栏必须成对或不出现；未被转义的 ``` 只能是报告自己写的（它不写）
  expect(markdown).not.toMatch(/^```/m)
}

describe('a hostile trajectory cannot forge structure or plant live resources in the markdown report', () => {
  const entry = hostileEntry()
  const markdown = buildMarkdownReport({
    entries: [{ trajectory: entry.trajectory, card: entry.card }],
    pack: DEFAULT_PACK,
    generatedAt: new Date('2026-10-22T12:00:00Z'),
    locale: 'zh-CN',
  })

  it('adds no heading beyond the ones the report writes itself', () => {
    expect(forgedHeadings(markdown)).toEqual([])
    // 报告自己的结构里只有一个一级标题；注入的 `# …` 若成了标题，这里会变成 2。
    expect(headings(markdown).filter((line) => line.startsWith('# '))).toHaveLength(1)
  })

  it('leaves no live image, link, html tag or fence', () => {
    expectInert(markdown)
  })

  it('still shows the text, so a reader can see what the trace said', () => {
    expect(markdown).toContain('attacker.example')
    expect(markdown).toContain('点此领奖')
  })
})

describe('the same holds for the comparison report', () => {
  const base = hostileEntry({}, 'a.json')
  const target = hostileEntry({ title: `t\n${FORGED}` }, 'b.json')
  const markdown = buildComparisonReport({
    base: { trajectory: base.trajectory, card: base.card },
    target: { trajectory: target.trajectory, card: target.card },
    generatedAt: new Date('2026-10-22T12:00:00Z'),
    locale: 'zh-CN',
  })

  it('stays inert', () => {
    expectInert(markdown)
    expect(forgedHeadings(markdown)).toEqual([])
    expect(headings(markdown).filter((line) => line.startsWith('# '))).toHaveLength(1)
  })
})

describe('the same holds for the pack comparison report', () => {
  it('escapes pack names and session labels', () => {
    const entry = hostileEntry()
    const evilPack = { ...DEFAULT_PACK, name: `evil\n${FORGED}\n${TRACKER}` }
    const input = {
      sessions: [entry.session],
      base: { name: DEFAULT_PACK.name, pack: DEFAULT_PACK },
      target: { name: evilPack.name, pack: evilPack },
      generatedAt: new Date('2026-10-22T12:00:00Z'),
      locale: 'zh-CN' as const,
    }
    const markdown = renderPackCompareMarkdown(input, buildPackCompareModel(input))
    expectInert(markdown)
  })
})

describe('the same holds for the agent diagnosis report, whose text is model output', () => {
  // 模型会读轨迹内容，轨迹里的提示注入能让它吐出任意文本。
  const evil = `结论如下\n${FORGED}\n${TRACKER}\n${PHISH}\n\`\`\`\n吞掉后面`
  const run = {
    ok: true,
    answer: '',
    diagnosis: {
      verdict: evil,
      rootCauses: [{ session: 's', cause: evil, evidence: evil }],
      actions: [{ action: evil, ruleId: 'a`b`c', rationale: evil }],
    },
    proposals: [{ id: `p\n${FORGED}`, rationale: evil, applied: [{ ruleId: 'x`y', severity: 'warn', effectiveImpact: 1 }], averageBefore: 90, averageAfter: 91, delta: 1 }],
    trace: { entries: [], toolCalls: 0, rounds: 1, truncated: false },
    usage: { prompt: 1, completion: 1 },
  } as unknown as AgentRun

  const markdown = renderAgentMarkdown({
    run,
    model: `m\n${FORGED}`,
    endpoint: 'https://llm.example/v1',
    pack: { ...DEFAULT_PACK, name: `p\n${FORGED}` },
    sessions: [],
    generatedAt: new Date('2026-10-22T12:00:00Z'),
    locale: 'zh-CN',
  })

  it('stays inert', () => {
    expectInert(markdown)
    expect(forgedHeadings(markdown)).toEqual([])
    expect(headings(markdown).filter((line) => line.startsWith('# '))).toHaveLength(1)
  })

  it('keeps a rule id with backticks inside one code span', () => {
    expect(markdown).toContain('``a`b`c``')
  })
})
