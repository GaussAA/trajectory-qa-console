import { describe, expect, it } from 'vitest'
import { parseTrajectory } from '../core/parsing'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { runRules } from '../core/rules/engine'
import { scoreTrajectory } from '../core/analysis/score'
import { buildJsonReport, buildMarkdownReport } from './report'

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

  it('writes a markdown report with overview, scores and findings', () => {
    const markdown = buildMarkdownReport({
      entries,
      pack: DEFAULT_PACK,
      generatedAt: new Date('2026-10-22T12:00:00Z'),
    })
    expect(markdown).toContain('# 轨迹质检报告')
    expect(markdown).toContain('| 会话 | 步骤 | token | 总分 |')
    expect(markdown).toContain('trace.json')
    expect(markdown).toContain('### 问题清单')
    expect(markdown).toContain('工具参数非法 JSON')
    expect(markdown).toContain('评分口径')
  })

  it('writes a machine-readable json report', () => {
    const json = JSON.parse(
      buildJsonReport({
        entries,
        pack: DEFAULT_PACK,
        generatedAt: new Date('2026-10-22T12:00:00Z'),
      }),
    )
    expect(json.sessions).toHaveLength(1)
    expect(json.sessions[0].score).toBe(card.overall)
    expect(json.sessions[0].findings.length).toBeGreaterThan(0)
    expect(json.rulePack.rules).toBe(DEFAULT_PACK.rules.length)
  })
})
