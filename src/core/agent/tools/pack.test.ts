import { describe, expect, it } from 'vitest'
import { scoreSession } from '../../analysis'
import { DEFAULT_PACK } from '../../rules/builtin-pack'
import { type PackProposal } from '../types'
import { contextWith, first } from '../test-support'
import { toolByName } from './index'

describe('pack tools', () => {
  it('lists rules, optionally scoped to a dimension', () => {
    const context = contextWith()
    const all = JSON.parse(toolByName('list_rules')?.run({}, context)?.content ?? '{}') as { total: number }
    const scoped = JSON.parse(
      toolByName('list_rules')?.run({ dimension: 'efficiency' }, context)?.content ?? '{}',
    ) as { rules: { dimension: string }[] }
    expect(all.total).toBeGreaterThan(0)
    expect(scoped.rules.every((rule) => rule.dimension === 'efficiency')).toBe(true)
    // 清单不带表达式：带了必然超长度上限，模型就会拿到半截 JSON。
    expect(JSON.stringify(all)).not.toContain('expr')
  })

  it('simulates a draft pack without touching the real one', () => {
    const context = contextWith()
    const before = first(context)
    const outcome = toolByName('simulate_pack')?.run(
      { edits: [{ ruleId: 'exec-tool-error', enabled: false }] },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      valid: boolean
      applied: { ruleId: string; effectiveImpact: number }[]
      rows: { before: number; after: number }[]
    }

    expect(outcome?.ok).toBe(true)
    expect(payload.valid).toBe(true)
    // 有效扣分由工具算：模型自己乘严重度系数会算错（实测踩过）。
    expect(payload.applied[0]?.effectiveImpact).toBeGreaterThan(0)
    // 关掉一条扣分规则，分数不可能更低——这是逻辑必然，不依赖具体数值。
    expect(payload.rows[0]!.after).toBeGreaterThanOrEqual(payload.rows[0]!.before)
    // 原包未被改动
    expect(DEFAULT_PACK.rules.find((rule) => rule.id === 'exec-tool-error')?.enabled).not.toBe(false)
    expect(scoreSession(before, DEFAULT_PACK, []).overall).toBe(payload.rows[0]!.before)
  })

  it('rejects a simulate with unknown rule ids', () => {
    const context = contextWith()
    const outcome = toolByName('simulate_pack')?.run({ edits: [{ ruleId: 'ghost' }] }, context)
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('missing')
  })

  it('rejects a draft pack that breaks the contract', () => {
    const context = contextWith()
    const outcome = toolByName('simulate_pack')?.run(
      { edits: [{ ruleId: 'exec-tool-error', expr: 'this is not an expression at all' }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('契约校验')
  })

  it('lists numeric literals and checks a replacement still compiles', () => {
    const context = contextWith()
    const listed = JSON.parse(
      toolByName('tune_literal')?.run({ ruleId: 'exec-tool-error' }, context)?.content ?? '{}',
    ) as { literals: { value: number }[] }
    expect(listed.literals.length).toBeGreaterThan(0)

    const replaced = toolByName('tune_literal')?.run(
      { ruleId: 'exec-tool-error', index: 0, next: 7 },
      context,
    )
    expect(replaced?.ok).toBe(true)
    expect(replaced?.content).toContain('after')
  })

  it('refuses a tuning that no longer compiles', () => {
    const context = contextWith()
    // 负下标没有任何数字常量可换
    const outcome = toolByName('tune_literal')?.run(
      { ruleId: 'exec-tool-error', index: 99, next: 1 },
      context,
    )
    expect(outcome?.ok).toBe(false)
  })

  it('records a proposal without touching the active pack', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      {
        rationale: '执行维扣分偏轻：死循环只降 25 分',
        edits: [{ ruleId: 'exec-dead-loop', severity: 'error', scoreImpact: 30 }],
      },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      accepted: boolean
      appliedToWorkspace: boolean
      averageBefore: number
    }

    expect(payload.accepted).toBe(true)
    // 明确告诉模型「没生效」：否则它会在结论里写「已修复」。
    expect(payload.appliedToWorkspace).toBe(false)
    expect(payload.averageBefore).toBeGreaterThan(0)

    const proposal = context.proposals[0]
    if (!proposal) throw new Error('proposal not collected')
    expect(proposal.id).toBe('p1')
    expect(proposal.pack.name).toContain('提案 1')
    expect(proposal.pack.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).toBe(30)
    expect(proposal.applied[0]?.effectiveImpact).toBe(30)
    // 生效包不能被悄悄改掉
    expect(DEFAULT_PACK.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).not.toBe(30)
  })

  it('numbers proposals in order', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const run = toolByName('propose_pack')
    run?.run({ rationale: 'a', edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 20 }] }, context)
    run?.run({ rationale: 'b', edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 40 }] }, context)
    expect(context.proposals?.map((proposal) => proposal.id)).toEqual(['p1', 'p2'])
  })

  it('refuses a proposal without a rationale', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 20 }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(context.proposals).toHaveLength(0)
  })

  it('refuses a proposal that breaks the contract, and records nothing', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { rationale: 'r', edits: [{ ruleId: 'exec-dead-loop', expr: 'this is not an expression' }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('契约校验')
    expect(context.proposals).toHaveLength(0)
  })

  it('refuses a proposal for an unknown rule', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { rationale: 'r', edits: [{ ruleId: 'ghost', scoreImpact: 20 }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('missing')
  })
})
