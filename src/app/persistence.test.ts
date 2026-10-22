import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { STORAGE_KEYS, createMemoryStorage, createPersistence } from './persistence'
import { createTelemetry } from './telemetry'

describe('persistence', () => {
  it('round-trips the pack and annotations through the envelope', () => {
    const store = createMemoryStorage()
    const port = createPersistence(store)

    expect(port.savePack(DEFAULT_PACK)).toBe(true)
    expect(
      port.saveAnnotations([
        { id: 'a1', trajectoryId: 't1', stepIndex: 2, dimension: 'semantic', severity: 'warn', note: '偏题' },
      ]),
    ).toBe(true)

    expect(port.loadPack().name).toBe(DEFAULT_PACK.name)
    expect(port.loadPack().rules).toHaveLength(DEFAULT_PACK.rules.length)
    expect(port.loadAnnotations()).toHaveLength(1)

    const raw = store.getItem(STORAGE_KEYS.pack)
    expect(raw).toContain('schemaVersion')
  })

  it('reads v0.1 bare payloads and migrates them forward', () => {
    const store = createMemoryStorage({
      [STORAGE_KEYS.legacyPack]: JSON.stringify(DEFAULT_PACK),
      [STORAGE_KEYS.legacyAnnotations]: JSON.stringify([
        { id: 'old', trajectoryId: 't', dimension: 'semantic', severity: 'info', note: '旧标注' },
      ]),
    })
    const port = createPersistence(store)
    expect(port.loadPack().rules).toHaveLength(DEFAULT_PACK.rules.length)
    expect(port.loadAnnotations()).toHaveLength(1)
  })

  it('falls back to defaults on corrupt or invalid data and records why', () => {
    const telemetry = createTelemetry()
    const corrupt = createPersistence(createMemoryStorage({ [STORAGE_KEYS.pack]: '{oops' }), telemetry)
    expect(corrupt.loadPack()).toBe(DEFAULT_PACK)
    expect(telemetry.snapshot().some((event) => event.name === 'storage:pack-corrupt')).toBe(true)

    const invalid = createPersistence(
      createMemoryStorage({
        [STORAGE_KEYS.pack]: JSON.stringify({ schemaVersion: 1, data: { version: 1 } }),
      }),
      telemetry,
    )
    expect(invalid.loadPack()).toBe(DEFAULT_PACK)
  })

  it('survives a storage that throws on write', () => {
    const telemetry = createTelemetry()
    const port = createPersistence(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => undefined,
      },
      telemetry,
    )
    expect(port.savePack(DEFAULT_PACK)).toBe(false)
    expect(telemetry.snapshot().some((event) => event.name === 'storage:write-failed')).toBe(true)
  })

  it('works with no storage at all', () => {
    const port = createPersistence(null)
    expect(port.loadPack()).toBe(DEFAULT_PACK)
    expect(port.loadAnnotations()).toEqual([])
    expect(port.savePack(DEFAULT_PACK)).toBe(false)
  })
})
