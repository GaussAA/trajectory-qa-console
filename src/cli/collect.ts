/** 从命令行参数展开成待分析文件清单（纯文件系统操作，不含分析）。
 *
 *  规则：
 *  - 目录递归展开，条目按名称排序 → 结果**稳定可复现**（CI 比对报告不会因
 *    文件系统顺序抖动）。
 *  - 跳过依赖/产物/工具目录与隐藏项；符号链接按 realpath 去重，避免环。
 *  - 文件数超限**直接失败**，不静默截断：门禁少扫一批文件比扫描失败更危险。
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export const TRACE_EXTENSIONS = ['.json', '.jsonl', '.txt'] as const

/** 递归时整棵跳过的目录名；这些目录里的轨迹不属于「本次要质检的东西」。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-cli',
  'coverage',
  '.git',
  '.hg',
  '.svn',
  '.workbuddy',
  '.github',
  '.vscode',
])

export type SkipReason = 'extension' | 'hidden' | 'unreadable' | 'outside-root'

export interface SkippedEntry {
  path: string
  reason: SkipReason
}

export interface CollectResult {
  files: string[]
  skipped: SkippedEntry[]
}

export type CollectErrorCode = 'path-missing' | 'no-files' | 'too-many-files'

export interface CollectError {
  code: CollectErrorCode
  /** 缺失路径或超限说明，供文案拼装。 */
  detail: string[]
}

export type CollectOutcome = { ok: true; value: CollectResult } | { ok: false; error: CollectError }

export interface CollectOptions {
  maxFiles: number
}

function isTraceFile(path: string): boolean {
  return (TRACE_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase())
}

/** True when `path` resolves (following symlinks) to somewhere outside `root`.
 *
 *  A symlink planted inside a scanned tree can otherwise drag in files the user
 *  never pointed at — and, with `--semantic` enabled, send them somewhere. */
function escapesRoot(path: string, root: string): boolean {
  const real = safeRealpath(path)
  return real !== root && !real.startsWith(root + sep)
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function collectFiles(inputs: string[], options: CollectOptions): CollectOutcome {
  const files: string[] = []
  const skipped: SkippedEntry[] = []
  const missing: string[] = []
  const seenFiles = new Set<string>()
  const seenDirs = new Set<string>()

  const pushFile = (absolute: string) => {
    const key = safeRealpath(absolute)
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    files.push(absolute)
  }

  const walk = (dir: string, root: string) => {
    const key = safeRealpath(dir)
    if (seenDirs.has(key)) return
    seenDirs.add(key)

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      skipped.push({ path: dir, reason: 'unreadable' })
      return
    }

    for (const name of entries.sort()) {
      // 隐藏项统一跳过：.git、.env、编辑器临时文件都在这一类。
      if (name.startsWith('.')) continue
      const child = join(dir, name)
      let stats
      try {
        stats = statSync(child)
      } catch {
        skipped.push({ path: child, reason: 'unreadable' })
        continue
      }
      if (stats.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(child, root)
        continue
      }
      // 目录扫描时，非轨迹扩展名不算「问题」，直接忽略，不写进 skipped。
      if (stats.isFile() && isTraceFile(child)) {
        // 符号链接只去重、不跟随到根外：链到别处的轨迹不属于本次扫描。
        if (escapesRoot(child, root)) {
          skipped.push({ path: child, reason: 'outside-root' })
          continue
        }
        pushFile(child)
      }
    }
  }

  for (const input of inputs) {
    const absolute = resolve(input)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      missing.push(input)
      continue
    }
    if (stats.isDirectory()) {
      // The root is what the user pointed at; its own realpath is the boundary.
      walk(absolute, safeRealpath(absolute))
      continue
    }
    if (isTraceFile(absolute)) pushFile(absolute)
    else skipped.push({ path: absolute, reason: 'extension' })
  }

  if (missing.length > 0) return { ok: false, error: { code: 'path-missing', detail: missing } }
  if (files.length === 0) {
    // 带上被跳过的显式文件，否则用户只看到「没找到」而不知道为什么。
    return { ok: false, error: { code: 'no-files', detail: skipped.map((entry) => entry.path) } }
  }
  if (files.length > options.maxFiles) {
    return {
      ok: false,
      error: { code: 'too-many-files', detail: [String(files.length), String(options.maxFiles)] },
    }
  }

  return { ok: true, value: { files, skipped } }
}
