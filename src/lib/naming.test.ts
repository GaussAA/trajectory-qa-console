import { describe, expect, it } from 'vitest'
import { BATCH_DEFAULTS, buildBatchNames } from './naming'

describe('buildBatchNames', () => {
  it('joins a prefix with padded serials', () => {
    expect(buildBatchNames(3, { prefix: 'exp', start: 1, pad: 2 })).toEqual(['exp-01', 'exp-02', 'exp-03'])
  })

  it('honours the start number and padding width', () => {
    expect(buildBatchNames(2, { prefix: 'r', start: 7, pad: 3 })).toEqual(['r-007', 'r-008'])
    expect(buildBatchNames(2, { prefix: 'r', start: 7, pad: 0 })).toEqual(['r-7', 'r-8'])
  })

  it('falls back to bare serials when no prefix is given', () => {
    expect(buildBatchNames(2, { prefix: '  ', start: 1, pad: 2 })).toEqual(['01', '02'])
  })

  it('returns nothing for non-positive counts', () => {
    expect(buildBatchNames(0, BATCH_DEFAULTS)).toEqual([])
    expect(buildBatchNames(-3, BATCH_DEFAULTS)).toEqual([])
  })

  it('clamps absurd padding instead of producing huge names', () => {
    expect(buildBatchNames(1, { prefix: 'x', start: 1, pad: 99 })).toEqual(['x-000001'])
  })
})
