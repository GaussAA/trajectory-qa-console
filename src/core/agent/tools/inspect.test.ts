import { describe, expect, it } from 'vitest'
import { scoreSession } from '../../analysis'
import { DEFAULT_PACK } from '../../rules/builtin-pack'
import { contextWith, first } from '../test-support'
import { toolByName } from './index'

describe('inspect tools', () => {
  it('list_sessions reports the same scores as the main path', () => {
    const context = contextWith()
    const outcome = toolByName('list_sessions')?.run({}, context)
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      sessions: { id: string; overall: number }[]
    }
    const session = first(context)
    expect(payload.sessions[0]?.overall).toBe(scoreSession(session, DEFAULT_PACK, []).overall)
  })

  it('rejects unknown session ids but lists the ones that exist', () => {
    const context = contextWith()
    const outcome = toolByName('get_card')?.run({ sessionId: 'nope' }, context)
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('available')
  })

  it('filters findings by severity', () => {
    const context = contextWith()
    const outcome = toolByName('get_findings')?.run(
      { sessionId: first(context).id, severity: 'error' },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as { findings: { severity: string }[] }
    expect(payload.findings.every((item) => item.severity === 'error')).toBe(true)
  })

  it('refuses to dump more than 40 steps at once', () => {
    const context = contextWith()
    const outcome = toolByName('read_steps')?.run({ sessionId: first(context).id, from: 1, to: 60 }, context)
    expect(outcome?.ok).toBe(false)
  })

  it('renders a step range with 1-based numbers', () => {
    const context = contextWith()
    const outcome = toolByName('read_steps')?.run({ sessionId: first(context).id, from: 2, to: 3 }, context)
    const payload = JSON.parse(outcome?.content ?? '{}') as { from: number; content: string }
    expect(payload.from).toBe(2)
    expect(payload.content).toContain('#2')
  })

  it('rejects an out-of-range step', () => {
    const context = contextWith()
    const outcome = toolByName('get_step')?.run({ sessionId: first(context).id, step: 99 }, context)
    expect(outcome?.ok).toBe(false)
  })

  it('finds text across steps', () => {
    const context = contextWith()
    const outcome = toolByName('search_steps')?.run(
      { sessionId: first(context).id, query: 'timeout' },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as { hits: { step: number }[] }
    const steps = payload.hits.map((hit) => hit.step)
    expect(steps.length).toBeGreaterThan(0)
    // 第 4 步是工具消息本体；第 3 步也命中，因为配对后 assistant 步同样携带结果。
    expect(steps).toContain(4)
  })

  it('compares two sessions but not a session with itself', () => {
    const context = contextWith()
    const [firstSession, secondSession] = context.sessions
    if (!firstSession || !secondSession) throw new Error('need two sessions')

    const same = toolByName('compare_sessions')?.run(
      { baseId: firstSession.id, targetId: firstSession.id },
      context,
    )
    expect(same?.ok).toBe(false)

    const diff = toolByName('compare_sessions')?.run(
      { baseId: firstSession.id, targetId: secondSession.id },
      context,
    )
    const payload = JSON.parse(diff?.content ?? '{}') as { overall: { delta: number } }
    expect(diff?.ok).toBe(true)
    expect(typeof payload.overall.delta).toBe('number')
  })
})
