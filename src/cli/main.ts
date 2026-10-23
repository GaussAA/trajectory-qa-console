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
import { analyze } from '../core/analysis'
import { buildComparisonJson, buildComparisonReport } from '../lib/report'
import { buildPackCompareJson, buildPackCompareMarkdown } from '../lib/pack-compare-report'
import { comparePacks } from '../core/pack-compare'
import { buildComparisonHtml } from '../lib/comparison-html'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { BUILTIN_PACK_EN } from '../core/rules/builtin-pack-en'
import { validatePack } from '../core/rules/contract'
import type { RulePack } from '../core/model'
import { isLocale, translate, type Locale, type MessageKey } from '../i18n/core'
import {
  judgeTrajectory,
  toFindings,
  buildMessages,
  fetchTransport,
  type LlmTransport,
} from '../core/semantic'
import { parseArgs, type CliOptions, type ReportFormat, type UsageError } from './args'
import { displayPath, runBatch } from './batch'
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

/** `--pack en` 这类别名直接指向内置包：免去用户先找 JSON 文件。 */
const BUILTIN_ALIASES: Record<string, RulePack> = {
  builtin: DEFAULT_PACK,
  'builtin-zh': DEFAULT_PACK,
  zh: DEFAULT_PACK,
  'builtin-en': BUILTIN_PACK_EN,
  en: BUILTIN_PACK_EN,
}

export function resolvePackAlias(name: string): RulePack | null {
  return BUILTIN_ALIASES[name.trim().toLowerCase()] ?? null
}

export type PackLoad = { ok: true; pack: RulePack } | { ok: false; message: string }

export function loadPack(path: string): PackLoad {
  const alias = resolvePackAlias(path)
  if (alias) return { ok: true, pack: alias }

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

export type ArtifactKind = 'md' | 'json' | 'html'

/** 格式 → 产物清单。`both` 沿用既有语义（md + json），`all` 三种都出；
 *  这样加 html 不会悄悄改变老脚本的行为。 */
export function artifactsFor(format: ReportFormat): ArtifactKind[] {
  switch (format) {
    case 'md':
      return ['md']
    case 'json':
      return ['json']
    case 'html':
      return ['html']
    case 'both':
      return ['md', 'json']
    case 'all':
      return ['md', 'json', 'html']
  }
}

const ARTIFACT_EXT: Record<ArtifactKind, string> = { md: 'md', json: 'json', html: 'html' }

/** 写盘按「产物清单」而非嵌套 if：加一种格式只需改 `artifactsFor`。 */
function writeArtifacts(
  dir: string,
  base: string,
  kinds: ArtifactKind[],
  contents: Partial<Record<ArtifactKind, string>>,
): string[] {
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const kind of kinds) {
    const content = contents[kind]
    if (content === undefined) continue
    const path = join(dir, `${base}.${ARTIFACT_EXT[kind]}`)
    writeFileSync(path, content, 'utf8')
    written.push(path)
  }
  return written
}

export interface CliDeps {
  /** 注入传输层：测试用假实现，生产用 fetch。 */
  transport?: LlmTransport
  env?: Record<string, string | undefined>
}

export interface SemanticConfig {
  url: string
  model: string
  apiKey: string
}

/** 密钥只从环境变量读：不落盘、不进命令行历史、不进日志。 */
export function resolveSemantic(
  options: CliOptions,
  env: Record<string, string | undefined>,
): { ok: true; config: SemanticConfig } | { ok: false; missing: string[] } {
  const url = options.llmUrl ?? env.TQA_LLM_URL ?? ''
  const model = options.llmModel ?? env.TQA_LLM_MODEL ?? ''
  const apiKey = env.TQA_LLM_API_KEY ?? ''
  const missing: string[] = []
  if (!url) missing.push('--llm-url / TQA_LLM_URL')
  if (!model) missing.push('--llm-model / TQA_LLM_MODEL')
  if (!apiKey) missing.push('TQA_LLM_API_KEY')
  return missing.length > 0 ? { ok: false, missing } : { ok: true, config: { url, model, apiKey } }
}

export async function main(
  argv: string[],
  io: { out?: Write; err?: Write } = {},
  deps: CliDeps = {},
): Promise<number> {
  const stdout = io.out ?? out
  const stderr = io.err ?? err
  const env = deps.env ?? process.env

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

  // 试跑：只打印将要发送的提示词，不调用模型（便于审计与离线检查）。
  if (options.semanticDryRun) {
    const first = collected.value.files[0] as string
    const read = readFileSync(first, 'utf8')
    const analyzed = analyze({ source: read, label: displayPath(first), pack })
    if (!analyzed.ok) {
      stderr(`✗ ${t(`error.${analyzed.error.code}` as MessageKey)}\n`)
      return EXIT.error
    }
    const session = analyzed.value[0]
    if (!session) {
      stderr(`✗ ${t('cli.nothingAnalyzable')}\n`)
      return EXIT.error
    }
    stdout(`${JSON.stringify(buildMessages(session.trajectory), null, 2)}\n`)
    return EXIT.ok
  }

  let semanticConfig: SemanticConfig | null = null
  if (options.semantic) {
    const resolved = resolveSemantic(options, env)
    if (!resolved.ok) {
      stderr(`✗ ${t('cli.err.semanticConfig', { missing: resolved.missing.join(' / ') })}\n`)
      return EXIT.error
    }
    semanticConfig = resolved.config
  }

  const transport = deps.transport ?? fetchTransport
  let judged = 0
  const semanticHook = semanticConfig
    ? async (session: Parameters<NonNullable<Parameters<typeof runBatch>[1]['semantic']>>[0]) => {
        if (judged >= options.semanticLimit) return null
        judged += 1
        const result = await judgeTrajectory(session.trajectory, {
          ...semanticConfig,
          transport,
          maxFindings: 8,
          timeoutMs: 20_000,
        })
        if (!result.ok) throw new Error(result.error.message)
        return toFindings(result.value, locale, session.id)
      }
    : undefined

  const result = await runBatch(collected.value.files, {
    locale,
    pack,
    failBelow: options.failBelow,
    maxFileBytes: options.maxFileBytes,
    semantic: semanticHook,
  })

  stdout(`${renderSummary(result, locale, { quiet: options.quiet })}\n`)

  if (result.semantic && result.semantic.sessions >= options.semanticLimit) {
    stderr(`${t('cli.semanticLimited', { limit: options.semanticLimit })}\n`)
  }

  if (result.entries.length === 0) {
    stderr(`✗ ${t('cli.nothingAnalyzable')}\n`)
    return EXIT.error
  }

  // 口径对比与轨迹对比互斥：两者都改写「报告是什么」的语义，混用只会误读。
  if (options.packCompare && options.compare) {
    stderr(`✗ ${t('cli.err.packCompareConflict')}\n`)
    return EXIT.error
  }

  if (options.packCompare) {
    const alias = resolvePackAlias(options.packCompare)
    const loaded = alias ? { ok: true as const, pack: alias } : loadPack(options.packCompare)
    if (!loaded.ok) {
      stderr(`✗ ${t('cli.err.pack-invalid', { detail: loaded.message })}\n`)
      return EXIT.error
    }

    const comparison = comparePacks(
      result.entries.map((entry) => ({ id: entry.trajectory.id, trajectory: entry.trajectory })),
      pack,
      loaded.pack,
    )
    const input = {
      sessions: result.entries.map((entry) => ({ id: entry.trajectory.id, trajectory: entry.trajectory })),
      base: { name: pack.name, pack },
      target: { name: loaded.pack.name, pack: loaded.pack },
      generatedAt: new Date(),
      locale,
    }
    const markdown = buildPackCompareMarkdown(input)
    const json = buildPackCompareJson(input)

    stdout(
      `${t('cli.packCompareLine', {
        base: pack.name,
        baseScore: comparison.baseAverage,
        target: loaded.pack.name,
        targetScore: comparison.targetAverage,
        delta: comparison.targetAverage - comparison.baseAverage,
      })}\n`,
    )

    if (options.out) {
      // 口径对比固定 md + json 两种形态：--format 管的是逐会话报告，不越权。
      const written = writeArtifacts(resolve(options.out), 'pack-compare', ['md', 'json'], {
        md: markdown,
        json,
      })
      for (const path of written) stdout(`${t('cli.wrote', { path })}\n`)
    }

    return result.gate && !result.gate.passed ? EXIT.gate : EXIT.ok
  }

  if (options.compare) {
    if (result.entries.length !== 2) {
      stderr(`✗ ${t('cli.err.compareNeedsTwo', { count: result.entries.length })}\n`)
      return EXIT.error
    }
    const [base, target] = result.entries as [(typeof result.entries)[0], (typeof result.entries)[0]]
    const generatedAt = new Date()
    const comparisonInput = { base, target, generatedAt, locale }
    const markdown = buildComparisonReport(comparisonInput)
    const json = buildComparisonJson(comparisonInput)
    const html = buildComparisonHtml(comparisonInput)

    stdout(
      `${t('cli.compareLine', {
        base: base.trajectory.label,
        baseScore: base.card.overall,
        target: target.trajectory.label,
        targetScore: target.card.overall,
        delta: target.card.overall - base.card.overall,
      })}\n`,
    )

    if (options.out) {
      const written = writeArtifacts(resolve(options.out), 'compare', artifactsFor(options.format), {
        md: markdown,
        json,
        html,
      })
      for (const path of written) stdout(`${t('cli.wrote', { path })}\n`)
    }

    // 门禁只卡「对照」那一份：基准是旧版本，不该被要求达标。
    return options.failBelow !== null && target.card.overall < options.failBelow ? EXIT.gate : EXIT.ok
  }

  if (options.out) {
    let written: string[]
    try {
      written = writeArtifacts(resolve(options.out), 'report', artifactsFor(options.format), {
        md: result.markdown,
        json: result.json,
        html: result.html,
      })
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
