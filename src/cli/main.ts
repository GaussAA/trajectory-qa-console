/** 命令行入口：解析参数 → 收集文件 → 批量分析 → 打印 / 落盘 → 退出码。
 *
 *  这一层只做 IO 与状态码，任何判断都下沉到 args / collect / batch，
 *  所以「算得对不对」可以在测试里直接用临时目录验证。
 *
 *  退出码是契约：0 通过、1 质量门禁未通过、2 用法/读写/无可分析内容。
 *  CI 只认这三个数，所以「什么都没分析到」必须是 2 而不是 0——空跑不能算通过。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { validatePack } from '../core/rules/contract'
import { isLocale, translate, type Locale, type MessageKey } from '../i18n/core'
import { parseArgs, type CliOptions, type UsageError } from './args'
import { runBatch } from './batch'
import { collectFiles } from './collect'
import { renderHelp, renderSummary } from './summary'
import { CLI_VERSION } from './version'

export const EXIT = { ok: 0, gate: 1, error: 2 } as const

export type Write = (chunk: string) => void

/** 默认写 stderr/stdout；测试注入自己的收集器，`bin.ts` 只负责进程侧的边界。 */
const out: Write = (chunk) => {
  process.stdout.write(chunk)
}
const err: Write = (chunk) => {
  process.stderr.write(chunk)
}

/** 参数错误时也尽量跟随用户显式指定的语言。 */
function peekLocale(argv: string[]): Locale {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--locale') {
      const next = argv[index + 1]
      return isLocale(next) ? next : 'zh-CN'
    }
    if (token.startsWith('--locale=')) {
      const value = token.slice('--locale='.length)
      return isLocale(value) ? value : 'zh-CN'
    }
  }
  return 'zh-CN'
}

function usageMessage(error: UsageError, locale: Locale): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  switch (error.code) {
    case 'unknown-flag':
      return t('cli.err.unknown-flag', { flag: error.flag ?? '' })
    case 'missing-value':
      return t('cli.err.missing-value', { flag: error.flag ?? '' })
    case 'invalid-format':
      return t('cli.err.invalid-format', { value: error.value ?? '' })
    case 'invalid-locale':
      return t('cli.err.invalid-locale', { value: error.value ?? '' })
    case 'invalid-number':
      return t('cli.err.invalid-number', {
        flag: error.flag ?? '',
        value: error.value ?? '',
        min: error.range?.min ?? 0,
        max: error.range?.max ?? 0,
      })
    case 'no-paths':
      return t('cli.err.no-paths')
  }
}

export type PackLoad = { ok: true; pack: typeof DEFAULT_PACK } | { ok: false; message: string }

export function loadPack(path: string): PackLoad {
  let raw: string
  try {
    raw = readFileSync(resolve(path), 'utf8')
  } catch {
    return { ok: false, message: `read ${path}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const validation = validatePack(parsed)
  if (!validation.ok) {
    const detail = validation.errors
      .slice(0, 3)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ')
    return { ok: false, message: detail }
  }
  return { ok: true, pack: validation.pack }
}

function writeReports(options: CliOptions, markdown: string, json: string): string[] {
  const dir = resolve(options.out as string)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  if (options.format !== 'json') {
    const path = join(dir, 'report.md')
    writeFileSync(path, markdown, 'utf8')
    written.push(path)
  }
  if (options.format !== 'md') {
    const path = join(dir, 'report.json')
    writeFileSync(path, json, 'utf8')
    written.push(path)
  }
  return written
}

export function main(argv: string[], io: { out?: Write; err?: Write } = {}): number {
  const stdout = io.out ?? out
  const stderr = io.err ?? err

  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    const locale = peekLocale(argv)
    stderr(`✗ ${usageMessage(parsed.error, locale)}\n${translate(locale, 'cli.helpHint')}\n`)
    return EXIT.error
  }

  const options = parsed.options
  const locale = options.locale
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)

  if (options.help) {
    stdout(`${renderHelp(locale, { version: CLI_VERSION })}\n`)
    return EXIT.ok
  }
  if (options.version) {
    stdout(`${CLI_VERSION}\n`)
    return EXIT.ok
  }

  const collected = collectFiles(options.paths, { maxFiles: options.maxFiles })
  if (!collected.ok) {
    const error = collected.error
    const message =
      error.code === 'path-missing'
        ? t('cli.err.path-missing', { path: error.detail.join(', ') })
        : error.code === 'too-many-files'
          ? t('cli.err.too-many-files', { count: error.detail[0] ?? '?', limit: error.detail[1] ?? '?' })
          : t('cli.err.no-files')
    stderr(`✗ ${message}\n`)
    return EXIT.error
  }

  let pack = DEFAULT_PACK
  if (options.pack) {
    const loaded = loadPack(options.pack)
    if (!loaded.ok) {
      stderr(`✗ ${t('cli.err.pack-invalid', { detail: loaded.message })}\n`)
      return EXIT.error
    }
    pack = loaded.pack
  }

  const result = runBatch(collected.value.files, {
    locale,
    pack,
    failBelow: options.failBelow,
    maxFileBytes: options.maxFileBytes,
  })

  stdout(`${renderSummary(result, locale, { quiet: options.quiet })}\n`)

  if (result.entries.length === 0) {
    stderr(`✗ ${t('cli.nothingAnalyzable')}\n`)
    return EXIT.error
  }

  if (options.out) {
    let written: string[]
    try {
      written = writeReports(options, result.markdown, result.json)
    } catch (error) {
      stderr(
        `✗ ${t('cli.err.write-failed', {
          path: options.out,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      )
      return EXIT.error
    }
    for (const path of written) stdout(`${t('cli.wrote', { path })}\n`)
  }

  return result.gate && !result.gate.passed ? EXIT.gate : EXIT.ok
}
