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

/** Raised when stored data was written by a *newer* version of this app.
 *
 *  This is not corruption — reading it as v1 would silently misinterpret the
 *  payload. Degrading to defaults and saying so is the honest option.
 *
 *  The message is locale-neutral on purpose: it only ever reaches telemetry,
 *  which is developer-facing data, not UI chrome. */
export class FutureSchemaVersionError extends Error {
  constructor(readonly foundVersion: number) {
    super(`stored schema version ${foundVersion} is newer than supported ${SCHEMA_VERSION}`)
    this.name = 'FutureSchemaVersionError'
  }
}

/** The migration chain: each entry upgrades data from version N to N+1.
 *
 *  Adding a version means adding one entry here — not editing every loader.
 *  Keep them small and pure so they can be tested without a storage. */
const MIGRATIONS: Record<number, (data: unknown) => unknown> = {
  // Example shape, added when v2 ships:
  // 1: (data) => ({ ...data, renamedField: (data as { old?: string }).old }),
}

/** Walk the chain from `fromVersion` up to `toVersion`.
 *
 *  A missing migration is a bug, not a condition to tolerate: skipping it would
 *  silently reinterpret the payload — the exact failure this chain exists to
 *  prevent. `toVersion` is a parameter so a test can exercise a future version
 *  without bumping SCHEMA_VERSION. */
export function migrateToCurrent(
  data: unknown,
  fromVersion: number,
  toVersion: number = SCHEMA_VERSION,
): unknown {
  let migrated = data
  for (let from = fromVersion; from < toVersion; from += 1) {
    const migrate = MIGRATIONS[from]
    if (!migrate) {
      throw new Error(
        `missing storage migration ${from} -> ${from + 1}: raising SCHEMA_VERSION requires adding it`,
      )
    }
    migrated = migrate(migrated)
  }
  return migrated
}

function unwrap(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && 'data' in parsed) {
    const envelope = parsed as Envelope<unknown>
    const version = envelope.schemaVersion
    if (typeof version !== 'number') return envelope.data
    if (version > SCHEMA_VERSION) throw new FutureSchemaVersionError(version)
    return migrateToCurrent(envelope.data, version)
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
    // 步号必须是非负整数：NaN、负数与小数都会造出指不到任何步的幽灵标注，
    // 而它照样会算进错误封顶。
    (record.stepIndex === undefined ||
      (typeof record.stepIndex === 'number' &&
        Number.isInteger(record.stepIndex) &&
        record.stepIndex >= 0))
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

  /** 读到过「更新版本写的」数据的键。这些键本次会话里只读不写。
   *
   *  读到未来版本时我们降级成默认值（不能把看不懂的东西当 v1 读），而界面挂载后的保存副作用
   *  会立刻把这份默认值写回同一个键——新版本写下的东西就这样被旧版本抹掉了。
   *  只拒绝读取不够，还得拒绝覆盖。普通的损坏数据不在此列：那不是别人的数据，覆盖它是对的。 */
  const locked = new Set<string>()
  const lockIfFuture = (key: string, error: unknown): void => {
    if (error instanceof FutureSchemaVersionError) locked.add(key)
  }

  const write = (key: string, value: string): boolean => {
    if (!store) return false
    if (locked.has(key)) {
      telemetry?.emit('storage:write-blocked', { key, reason: 'newer-schema' }, 'warn')
      return false
    }
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
        lockIfFuture(STORAGE_KEYS.pack, error)
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
        lockIfFuture(STORAGE_KEYS.annotations, error)
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
        lockIfFuture(STORAGE_KEYS.sessionNotes, error)
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
        lockIfFuture(STORAGE_KEYS.packVariants, error)
        telemetry?.emit('storage:variants-corrupt', { error: String(error) }, 'warn')
        return []
      }
    },

    savePackVariants(variants) {
      return write(STORAGE_KEYS.packVariants, wrap(variants))
    },
  }
}
