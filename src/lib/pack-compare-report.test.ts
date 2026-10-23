import { describe, expect, it } from 'vitest'
import { analyze } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { buildPackCompareJson, buildPackCompareMarkdown } from './pack-compare-report'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '结果' },
  { role: 'assistant', content: '答复完毕' },
])

function sessions() {
  const parsed = analyze({ source: TRACE, label: 'single-error.json', pack: DEFAULT_PACK })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.map((session) => ({ id: session.id, trajectory: session.trajectory }))
}

const lenient = {
  name: '宽松口径',
  pack: {
    ...DEFAULT_PACK,
    name: '宽松',
    rules: DEFAULT_PACK.rules.map((rule) =>
      rule.id === 'structure-invalid-args' ? { ...rule, enabled: false } : rule,
    ),
  },
}

const GENERATED = new Date('2026-10-23T12:00:00Z')

describe('pack comparison reports', () => {
  it('writes a localized markdown table with an average row', () => {
    const markdown = buildPackCompareMarkdown({
      sessions: sessions(),
      base: { name: '内置中文包', pack: DEFAULT_PACK },
      target: lenient,
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })

    expect(markdown).toContain('# 口径对比报告')
    expect(markdown).toContain('- 基准口径：内置中文包')
    expect(markdown).toContain('| 会话 | 基准 | 对照 | 变化 |')
    expect(markdown).toContain('single-error.json')
    expect(markdown).toContain('| **平均** | **74** | **100** | **+26** |')
  })

  it('localizes for english without translating rule data', () => {
    const markdown = buildPackCompareMarkdown({
      sessions: sessions(),
      base: { name: 'Builtin zh', pack: DEFAULT_PACK },
      target: { name: 'Lenient', pack: lenient.pack },
      generatedAt: GENERATED,
      locale: 'en',
    })

    expect(markdown).toContain('# Pack Comparison Report')
    expect(markdown).toContain('| Session | Baseline | Candidate | Delta |')
    // 口径名由调用方给定（英文场景传英文名）；唯一可能残留的中文是规则包内部数据
    expect(markdown).toContain('Candidate pack: Lenient')
  })

  it('says so when both packs are identical', () => {
    const markdown = buildPackCompareMarkdown({
      sessions: sessions(),
      base: { name: 'A', pack: DEFAULT_PACK },
      target: { name: 'B', pack: DEFAULT_PACK },
      generatedAt: GENERATED,
      locale: 'zh-CN',
    })
    expect(markdown).toContain('两份口径相同，没有可比的差异。')
    expect(markdown).not.toContain('| 会话 |')
  })

  it('emits a machine-readable json with stable keys', () => {
    const json = JSON.parse(
      buildPackCompareJson({
        sessions: sessions(),
        base: { name: '内置中文包', pack: DEFAULT_PACK },
        target: lenient,
        generatedAt: GENERATED,
        locale: 'zh-CN',
      }),
    )

    expect(json.base.rules).toBe(DEFAULT_PACK.rules.length)
    expect(json.average.delta).toBe(26)
    expect(json.sessions[0].delta).toBe(26)
    expect(json.identical).toBe(false)
  })
})
