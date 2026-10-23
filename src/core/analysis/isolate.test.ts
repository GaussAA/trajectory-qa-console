/** Invariant 5: one bad session must not cost the others.
 *
 *  `analyze` used to wrap the whole loop in a single try, so a session that
 *  threw failed the entire file — and discarded the sessions that had already
 *  succeeded. These tests drive a real multi-session file through a metrics
 *  computation that fails on demand.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Trajectory } from '../model'

/** Set by each test; read inside the mock. Held on globalThis because vi.mock
 *  factories run at import time, before local bindings are initialised. */
type Gate = { failOn: number[]; calls: number }
const gate: Gate = { failOn: [], calls: 0 }
;(globalThis as unknown as { __metricsGate?: Gate }).__metricsGate = gate

vi.mock('./metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metrics')>()
  return {
    ...actual,
    computeMetrics: (trajectory: Trajectory) => {
      const current = (globalThis as unknown as { __metricsGate?: Gate }).__metricsGate
      const call = (current?.calls ?? 0) + 1
      if (current) current.calls = call
      if (current?.failOn.includes(call)) throw new Error('指标计算炸了')
      return actual.computeMetrics(trajectory)
    },
  }
})

const { analyze } = await import('./index')

/** three sessions in one file, one per line (JSONL). */
const SOURCE = [
  JSON.stringify([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回答一' },
  ]),
  JSON.stringify([
    { role: 'user', content: '第二条' },
    { role: 'assistant', content: '回答二' },
  ]),
  JSON.stringify([
    { role: 'user', content: '第三条' },
    { role: 'assistant', content: '回答三' },
  ]),
].join('\n')

describe('analyze isolates a failing session', () => {
  it('keeps the healthy sessions when one of them throws', () => {
    gate.failOn = [2]
    gate.calls = 0

    const result = analyze({ source: SOURCE, label: 'three.jsonl', idPrefix: 'iso' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.sessions).toHaveLength(2)
    expect(result.value.issues).toHaveLength(1)
    expect(result.value.issues[0]?.index).toBe(1)
    expect(result.value.issues[0]?.message).toContain('指标计算炸了')

    // The survivors are the ones that did not throw — not a truncated prefix.
    expect(result.value.sessions.map((session) => session.trajectory.label)).toBeDefined()
    expect(result.value.sessions.some((session) => session.trajectory.steps.length > 0)).toBe(true)
  })

  it('still fails the file when every session was dropped', () => {
    gate.failOn = [1, 2, 3]
    gate.calls = 0

    const result = analyze({ source: SOURCE, label: 'three.jsonl' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('analysis-failed')
    // "I analysed your file" must not be claimed when nothing survived.
    expect(result.error.message).toBeTruthy()
  })

  it('reports no issues when everything succeeds', () => {
    gate.failOn = []
    gate.calls = 0

    const result = analyze({ source: SOURCE, label: 'three.jsonl' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sessions).toHaveLength(3)
    expect(result.value.issues).toHaveLength(0)
  })
})
