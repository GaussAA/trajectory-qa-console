import { describe, expect, it } from 'vitest'
import { createTelemetry, installGlobalErrorHandlers } from './telemetry'

describe('telemetry', () => {
  it('keeps a bounded ring buffer with monotonic sequence numbers', () => {
    const telemetry = createTelemetry({ limit: 3 })
    for (let i = 0; i < 5; i += 1) telemetry.emit(`event-${i}`)

    const events = telemetry.snapshot()
    expect(events).toHaveLength(3)
    expect(events.map((event) => event.name)).toEqual(['event-2', 'event-3', 'event-4'])
    expect(events[2]?.seq).toBe(5)
  })

  it('measures durations and records thrown errors before rethrowing', () => {
    let tick = 0
    const telemetry = createTelemetry({ clock: () => (tick += 10) })

    expect(telemetry.measure('ok', () => 42)).toBe(42)
    expect(telemetry.snapshot()[0]?.data?.durationMs).toBe(10)

    expect(() =>
      telemetry.measure('boom', () => {
        throw new Error('nope')
      }),
    ).toThrowError('nope')

    const failure = telemetry.snapshot()[1]
    expect(failure?.level).toBe('error')
    expect(failure?.data?.message).toBe('nope')
  })

  it('prefixes child scopes without losing the parent buffer', () => {
    const telemetry = createTelemetry()
    telemetry.child('parse').emit('done', { steps: 3 })
    expect(telemetry.snapshot()[0]?.name).toBe('parse:done')
  })

  it('never lets a broken subscriber break the emitter', () => {
    const telemetry = createTelemetry()
    telemetry.subscribe(() => {
      throw new Error('subscriber exploded')
    })
    expect(() => telemetry.emit('still-works')).not.toThrow()
    expect(telemetry.snapshot()).toHaveLength(1)
  })

  it('clears events on demand', () => {
    const telemetry = createTelemetry()
    telemetry.emit('a')
    telemetry.clear()
    expect(telemetry.snapshot()).toHaveLength(0)
  })

  it('captures window errors and unhandled rejections until uninstalled', () => {
    const telemetry = createTelemetry()
    const target = new EventTarget()
    const uninstall = installGlobalErrorHandlers(
      telemetry,
      target as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    )

    const errorEvent = Object.assign(new Event('error'), {
      message: 'boom',
      filename: 'x.ts',
      lineno: 3,
    })
    target.dispatchEvent(errorEvent)
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') })
    target.dispatchEvent(rejection)

    const names = telemetry.snapshot().map((event) => event.name)
    expect(names).toContain('window:error')
    expect(names).toContain('window:unhandledrejection')

    uninstall()
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'after uninstall' }))
    expect(telemetry.snapshot()).toHaveLength(2)
  })
})
