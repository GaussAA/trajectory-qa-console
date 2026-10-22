import { describe, expect, it } from 'vitest'
import type { Step } from '../core/model'
import { bucketizeSteps, computeWindow } from './windowing'

const ROW = 46

describe('computeWindow', () => {
  it('returns an empty window for empty lists', () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 500, rowHeight: ROW, count: 0 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
      offsetY: 0,
    })
  })

  it('covers the viewport plus overscan at the top', () => {
    const range = computeWindow({ scrollTop: 0, viewportHeight: 460, rowHeight: ROW, count: 100 })
    expect(range.start).toBe(0)
    expect(range.end).toBe(22) // 10 visible + 6 above + 6 below
    expect(range.totalHeight).toBe(4600)
    expect(range.offsetY).toBe(0)
  })

  it('shifts the window with the scroll position', () => {
    const range = computeWindow({ scrollTop: 460, viewportHeight: 460, rowHeight: ROW, count: 100 })
    expect(range.start).toBe(4)
    expect(range.end).toBe(26)
    expect(range.offsetY).toBe(4 * ROW)
  })

  it('clamps at the end of the list', () => {
    const range = computeWindow({ scrollTop: 10_000, viewportHeight: 460, rowHeight: ROW, count: 100 })
    expect(range.start).toBe(99)
    expect(range.end).toBe(100)
  })

  it('degrades to one row when the viewport has no layout yet', () => {
    const range = computeWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: ROW, count: 100 })
    expect(range.start).toBe(0)
    expect(range.end).toBeGreaterThan(0)
    expect(range.end).toBeLessThanOrEqual(22)
  })
})

function syntheticSteps(count: number): Step[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool',
    text: `第 ${index} 步`,
    reasoning: '',
    toolCalls: [],
    tokens: { input: 0, output: 0, total: (index % 10) + 1, estimated: true },
    charCount: 5,
    raw: null,
    parseNotes: [],
  }))
}

describe('bucketizeSteps', () => {
  it('keeps small traces one bucket per step', () => {
    const steps = syntheticSteps(12)
    const buckets = bucketizeSteps({ steps, maxTokens: 10, hasError: () => false })
    expect(buckets).toHaveLength(12)
    expect(buckets[0]).toMatchObject({ start: 0, end: 1 })
  })

  it('aggregates a 10k trace into at most 180 contiguous buckets', () => {
    const steps = syntheticSteps(10_000)
    const buckets = bucketizeSteps({ steps, maxTokens: 10, hasError: () => false })

    expect(buckets.length).toBeLessThanOrEqual(180)
    expect(buckets.length).toBeGreaterThan(100)
    expect(buckets[0]?.start).toBe(0)
    expect(buckets[buckets.length - 1]?.end).toBe(10_000)

    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i]?.start).toBe(buckets[i - 1]?.end)
    }
  })

  it('marks a bucket when any step in it carries an error', () => {
    const steps = syntheticSteps(300)
    const buckets = bucketizeSteps({ steps, maxTokens: 10, hasError: (index) => index === 151 })
    expect(buckets.some((bucket) => bucket.error)).toBe(true)
    expect(buckets.filter((bucket) => bucket.error)).toHaveLength(1)
  })

  it('normalises heights between the configured bounds', () => {
    const steps = syntheticSteps(50)
    const buckets = bucketizeSteps({ steps, maxTokens: 10, hasError: () => false })
    for (const bucket of buckets) {
      expect(bucket.height).toBeGreaterThanOrEqual(6)
      expect(bucket.height).toBeLessThanOrEqual(28)
    }
  })
})
