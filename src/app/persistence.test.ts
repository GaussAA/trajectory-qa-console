import { describe, expect, it } from 'vitest'
import type { PackVariant } from '../core/model'
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

  it('round-trips session notes and drops malformed records', () => {
    const store = createMemoryStorage()
    const port = createPersistence(store)

    expect(
      port.saveSessionNotes([{ trajectoryId: 'trace-1', name: '第三版', note: '改了 system prompt' }]),
    ).toBe(true)
    expect(port.loadSessionNotes()).toEqual([
      { trajectoryId: 'trace-1', name: '第三版', note: '改了 system prompt' },
    ])

    store.setItem(
      STORAGE_KEYS.sessionNotes,
      JSON.stringify({
        schemaVersion: 1,
        data: [
          { trajectoryId: 'ok', name: 'n', note: '' },
          { trajectoryId: 'bad', name: 42, note: '' },
          { nope: true },
        ],
      }),
    )
    expect(port.loadSessionNotes()).toEqual([{ trajectoryId: 'ok', name: 'n', note: '' }])
  })

  it('round-trips pack variants and drops invalid packs', () => {
    const store = createMemoryStorage()
    const port = createPersistence(store)

    const good: PackVariant = {
      id: 'v1',
      name: '宽松',
      pack: { ...DEFAULT_PACK, name: '宽松口径' },
      savedAt: '2026-10-23T10:00:00.000Z',
    }
    expect(port.savePackVariants([good])).toBe(true)
    expect(port.loadPackVariants()).toEqual([good])

    // 坏包不拖垮整个列表：逐条校验，坏的那条丢掉
    store.setItem(
      STORAGE_KEYS.packVariants,
      JSON.stringify({
        schemaVersion: 1,
        data: [good, { id: 'v2', name: '坏包', pack: { nope: true }, savedAt: 'x' }, { nope: true }],
      }),
    )
    expect(port.loadPackVariants()).toEqual([good])
  })

  it('works with no storage at all', () => {
    const port = createPersistence(null)
    expect(port.loadPack()).toBe(DEFAULT_PACK)
    expect(port.loadAnnotations()).toEqual([])
    expect(port.savePack(DEFAULT_PACK)).toBe(false)
    expect(port.loadSessionNotes()).toEqual([])
    expect(port.saveSessionNotes([])).toBe(false)
    expect(port.loadPackVariants()).toEqual([])
    expect(port.savePackVariants([])).toBe(false)
  })
})
