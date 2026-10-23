/** Persistence behind a port.
 *
 *  Two adapters justify the seam: localStorage in production, an in-memory store
 *  in tests. Every read is versioned and validated; a corrupt or outdated blob
 *  degrades to defaults instead of taking the app down.
 */

import type { Annotation, PackVariant, RulePack, SessionNote } from '../core/model'
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
  sessionNotes: 'tqa.session-notes',
  packVariants: 'tqa.pack-variants',
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
  loadSessionNotes(): SessionNote[]
  saveSessionNotes(notes: SessionNote[]): boolean
  loadPackVariants(): PackVariant[]
  savePackVariants(variants: PackVariant[]): boolean
}

/** 变体打包格式：跨机器迁移口径库用。与存储键同一条校验路径。 */
export interface PackVariantBundle {
  format: 'tqa-variants'
  version: 1
  exportedAt: string
  variants: PackVariant[]
}

export function serializePackVariants(variants: PackVariant[]): string {
  const bundle: PackVariantBundle = {
    format: 'tqa-variants',
    version: 1,
    exportedAt: new Date().toISOString(),
    variants,
  }
  return JSON.stringify(bundle, null, 2)
}

/** 容忍裸数组（手工编辑过的文件），逐条校验，坏记录只丢自己。 */
export function parsePackVariants(parsed: unknown): PackVariant[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { variants?: unknown }).variants)
      ? (parsed as { variants: unknown[] }).variants
      : []
  return list.filter(isPackVariant)
}

/** 上限是防线不是功能：变体应是少数几个精心调出来的口径，不是杂物堆。 */
export const MAX_PACK_VARIANTS = 20

function isPackVariant(value: unknown): value is PackVariant {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return false
  if (typeof record.savedAt !== 'string') return false
  if (!record.pack) return false
  // 规则包本体走既有校验：坏包丢弃，不让一条脏数据拖垮整个列表。
  return validatePack(record.pack).ok
}

function isSessionNote(value: unknown): value is SessionNote {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!(typeof record.trajectoryId === 'string' && typeof record.name === 'string' && typeof record.note === 'string'))
    return false
  // tags 可选（旧数据没有）；存在则必须是字符串数组
  if (record.tags === undefined) return true
  return Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === 'string')
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

    loadSessionNotes() {
      const raw = read(STORAGE_KEYS.sessionNotes)
      if (!raw) return []
      try {
        const data = unwrap(raw)
        if (!Array.isArray(data)) return []
        return data.filter(isSessionNote)
      } catch (error) {
        telemetry?.emit('storage:notes-corrupt', { error: String(error) }, 'warn')
        return []
      }
    },

    saveSessionNotes(notes) {
      return write(STORAGE_KEYS.sessionNotes, wrap(notes))
    },

    loadPackVariants() {
      const raw = read(STORAGE_KEYS.packVariants)
      if (!raw) return []
      try {
        const data = unwrap(raw)
        if (!Array.isArray(data)) return []
        return data.filter(isPackVariant)
      } catch (error) {
        telemetry?.emit('storage:variants-corrupt', { error: String(error) }, 'warn')
        return []
      }
    },

    savePackVariants(variants) {
      return write(STORAGE_KEYS.packVariants, wrap(variants))
    },
  }
}
