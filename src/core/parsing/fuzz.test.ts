import { describe, expect, it } from 'vitest'
import { parseTrajectory } from './index'

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomValue(random: () => number, depth = 0): unknown {
  const pick = Math.floor(random() * 8)
  if (depth > 3) return [null, true, 0, 'x'][Math.floor(random() * 4)]
  switch (pick) {
    case 0:
      return null
    case 1:
      return random() > 0.5
    case 2:
      return Math.round(random() * 1000)
    case 3:
      return ['user', 'assistant', 'tool', 'system', ''][Math.floor(random() * 5)]
    case 4:
      return Array.from({ length: Math.floor(random() * 3) }, () => randomValue(random, depth + 1))
    case 5:
      return { role: randomValue(random, depth + 1), content: randomValue(random, depth + 1) }
    case 6:
      return {
        role: 'assistant',
        tool_calls: [{ id: 'c', function: { name: 'f', arguments: randomValue(random, depth + 1) } }],
      }
    default:
      return {
        messages: Array.from({ length: Math.floor(random() * 3) }, () => randomValue(random, depth + 2)),
      }
  }
}

describe('parser fuzz', () => {
  it('never throws on arbitrary JSON shapes', () => {
    const random = mulberry32(20261022)
    for (let i = 0; i < 600; i += 1) {
      const text = JSON.stringify(randomValue(random))
      expect(() => parseTrajectory(text, `fuzz-${i}`)).not.toThrow()
    }
  })

  it('keeps structural invariants whenever it does succeed', () => {
    const random = mulberry32(7)
    let successes = 0

    for (let i = 0; i < 300; i += 1) {
      const result = parseTrajectory(JSON.stringify(randomValue(random)), `fuzz-${i}`)
      if (!result.ok) continue
      successes += 1

      for (const trajectory of result.value) {
        trajectory.steps.forEach((step, index) => {
          expect(step.index).toBe(index)
          expect(step.tokens.total).toBeGreaterThanOrEqual(0)
          for (const call of step.toolCalls) {
            expect(typeof call.name).toBe('string')
            // A call either has a paired result or is reportable as unpaired.
            if (!call.result) expect(call.id.length).toBeGreaterThan(0)
          }
          // A tool step either links to a call, or carries the orphan note.
          if (step.role === 'tool' && !step.forCallId) {
            const explained =
              trajectory.parseNotes.some((note) => note.includes('不存在的调用')) ||
              step.result?.callId === ''
            expect(explained).toBe(true)
          }
        })
      }
    }

    expect(successes).toBeGreaterThan(10)
  })

  it('survives truncated and binary-ish text without throwing', () => {
    const samples = ['{"messages":[', '\u0000\u0001\u0002', '[]', 'null', '123', '"text"', '{"steps":{}}']
    for (const sample of samples) {
      expect(() => parseTrajectory(sample, 'edge')).not.toThrow()
    }
  })
})
