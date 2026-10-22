// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadText } from './exporters'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('downloadText', () => {
  it('creates an object url, clicks a named anchor, then revokes it', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    downloadText('report.md', '# hi', 'text/markdown')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })
})
