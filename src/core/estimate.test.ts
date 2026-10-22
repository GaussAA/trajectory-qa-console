import { describe, expect, it } from 'vitest'
import { estimateTokens, formatClock, formatDuration, formatTokens } from './estimate'

describe('estimate', () => {
  it('weights CJK glyphs heavier than latin characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('hello world')).toBe(3)
  })

  it('formats token counts at three magnitudes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.50k')
    expect(formatTokens(15_000)).toBe('15.0k')
    expect(formatTokens(2_500_000)).toBe('2.50M')
    expect(formatTokens(Number.NaN)).toBe('—')
  })

  it('formats durations from milliseconds to minutes', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m5s')
  })

  it('formats wall-clock timestamps and tolerates missing ones', () => {
    expect(formatClock(undefined)).toBe('—')
    expect(formatClock(Date.UTC(2026, 0, 1, 0, 0, 0))).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})
