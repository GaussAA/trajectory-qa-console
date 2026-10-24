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

  it('redacts payload fields that may hold trace text or credentials', () => {
    const telemetry = createTelemetry()
    const secret = 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(4)
    telemetry.emit('ingest:file', {
      file: 'trace.json',
      chars: 4096,
      sessions: 2,
      text: '患者的手机号是 13812345678，邮箱 a@b.com，病史……'.repeat(20),
      args: '{"query":"用户的身份证号 110101199001011234"}',
      nested: { content: '完整轨迹正文', apiKey: secret },
    })

    const data = telemetry.snapshot()[0]?.data
    // Diagnostics stay usable: counts and file names survive.
    expect(data?.file).toBe('trace.json')
    expect(data?.chars).toBe(4096)
    expect(data?.sessions).toBe(2)

    // Content does not.
    expect(data?.text).not.toContain('13812345678')
    expect(data?.args).not.toContain('110101')
    expect(data?.nested).toEqual({
      content: '[hidden: 6 chars]',
      apiKey: '[hidden: 67 chars]',
    })
  })

  it('clips long strings instead of keeping them whole', () => {
    const telemetry = createTelemetry()
    const long = 'x'.repeat(5000)
    telemetry.emit('ingest:file', { note: long })

    const note = telemetry.snapshot()[0]?.data?.note
    expect(typeof note).toBe('string')
    expect((note as string).length).toBeLessThan(200)
    expect(note).toContain('5000 chars')
  })

  it('keeps error messages but drops the stack', () => {
    const telemetry = createTelemetry()
    expect(() =>
      telemetry.measure('boom', () => {
        throw new Error(`失败于 C:\\Users\\someone\\secrets\\trace.json：${'y'.repeat(400)}`)
      }),
    ).toThrowError(/失败于/)

    const data = telemetry.snapshot()[0]?.data
    expect(data?.error).toBe('Error')
    expect((data?.message as string).length).toBeLessThan(200)
    expect(JSON.stringify(data)).not.toContain('    at ')
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
