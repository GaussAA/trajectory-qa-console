/** Persistence behind a port.
 *
 *  Two adapters justify the seam: localStorage in production, an in-memory store
 *  in tests. Every read is versioned and validated; a corrupt or outdated blob
 *  degrades to defaults instead of taking the app down.
 */

import type { Annotation, RulePack } from '../core/model'
import { validatePack } from '../core/rules/contract'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import type { Telemetry } from './telemetry'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createMemoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

/** localStorage can throw on access (privacy mode, file://, disabled cookies). */
export function createBrowserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const probe = '__tqa_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

export const STORAGE_KEYS = {
  pack: 'tqa.pack',
  annotations: 'tqa.annotations',
  /** Keys written by v0.1 (raw JSON, no envelope). Read once, then migrated. */
  legacyPack: 'tqa.pack.v1',
  legacyAnnotations: 'tqa.annotations.v1',
} as const

export const SCHEMA_VERSION = 1

interface Envelope<T> {
  schemaVersion: number
  data: T
}

function wrap<T>(data: T): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, data } satisfies Envelope<T>)
}

function unwrap(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && 'data' in parsed) {
    return (parsed as Envelope<unknown>).data
  }
  // v0.1 wrote the payload bare; treat it as schemaVersion 1.
  return parsed
}

function isAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.trajectoryId === 'string' &&
    typeof record.note === 'string' &&
    typeof record.dimension === 'string' &&
    (record.severity === 'error' || record.severity === 'warn' || record.severity === 'info') &&
    (record.stepIndex === undefined || typeof record.stepIndex === 'number')
  )
}

export interface PersistencePort {
  loadPack(): RulePack
  savePack(pack: RulePack): boolean
  loadAnnotations(): Annotation[]
  saveAnnotations(annotations: Annotation[]): boolean
}

export function createPersistence(store: StorageLike | null, telemetry?: Telemetry): PersistencePort {
  const read = (key: string): string | null => {
    try {
      return store?.getItem(key) ?? null
    } catch (error) {
      telemetry?.emit('storage:read-failed', { key, error: String(error) }, 'warn')
      return null
    }
  }

  const write = (key: string, value: string): boolean => {
    if (!store) return false
    try {
      store.setItem(key, value)
      return true
    } catch (error) {
      telemetry?.emit('storage:write-failed', { key, error: String(error) }, 'warn')
      return false
    }
  }

  return {
    loadPack() {
      const raw = read(STORAGE_KEYS.pack) ?? read(STORAGE_KEYS.legacyPack)
      if (!raw) return DEFAULT_PACK
      try {
        const result = validatePack(unwrap(raw))
        if (!result.ok) {
          telemetry?.emit('storage:pack-invalid', { errors: result.errors.slice(0, 3) }, 'warn')
          return DEFAULT_PACK
        }
        return result.pack
      } catch (error) {
        telemetry?.emit('storage:pack-corrupt', { error: String(error) }, 'warn')
        return DEFAULT_PACK
      }
    },

    savePack(pack) {
      return write(STORAGE_KEYS.pack, wrap(pack))
    },

    loadAnnotations() {
      const raw = read(STORAGE_KEYS.annotations) ?? read(STORAGE_KEYS.legacyAnnotations)
      if (!raw) return []
      try {
        const data = unwrap(raw)
        if (!Array.isArray(data)) return []
        return data.filter(isAnnotation)
      } catch (error) {
        telemetry?.emit('storage:annotations-corrupt', { error: String(error) }, 'warn')
        return []
      }
    },

    saveAnnotations(annotations) {
      return write(STORAGE_KEYS.annotations, wrap(annotations))
    },
  }
}
