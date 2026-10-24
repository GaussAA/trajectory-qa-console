/** 命令行参数解析（纯函数，无 IO）。
 *
 *  设计取舍：
 *  - 支持 `--flag value` 与 `--flag=value` 两种写法，`--` 之后一律视为路径。
 *  - 错误用**代码**返回（`code` + `detail`），不用中文字符串——翻译交给 main，
 *    这样解析层可以在任何语言下复用，测试也不必匹配文案。
 *  - `--help` / `--version` 直接短路：即使缺路径也算成功，否则用户看不到帮助。
 */

import { isLocale, type Locale } from '../i18n/core'

export const CLI_NAME = 'trajectory-qa'

export type ReportFormat = 'md' | 'json' | 'html' | 'both' | 'all'

export interface CliOptions {
  paths: string[]
  format: ReportFormat
  /** 报告输出目录；null 表示只打屏。 */
  out: string | null
  locale: Locale
  /** 自定义规则包路径；null 表示内置包。 */
  pack: string | null
  /** 质量门禁：任一会话低于此分即失败；null 表示不设门禁。 */
  failBelow: number | null
  maxFiles: number
  maxFileBytes: number
  /** 语义复核（调用 OpenAI 兼容接口），默认关闭。 */
  semantic: boolean
  llmUrl: string | null
  llmModel: string | null
  /** 单次运行最多复核多少个会话，兜住成本。 */
  semanticLimit: number
  /** 只打印将要发送的提示词，不调用模型。 */
  semanticDryRun: boolean
  /** 智能体诊断（调用端点并多轮使用工具），默认关闭。 */
  agent: boolean
  /** 只打印系统提示与工具清单，不调用模型。 */
  agentDryRun: boolean
  /** 智能体轮次上限；null 表示用 `AGENT_BUDGET` 的默认值。 */
  agentRounds: number | null
  /** 把完整调用轨迹写成 JSON 文件；null 表示不写。 */
  agentTrace: string | null
  /** 定向诊断：想让模型专门看什么；null 表示用默认任务。 */
  agentTask: string | null
  /** 本地诊断服务（`qa serve`）：不带路径、常驻运行。 */
  serve: boolean
  port: number
  host: string
  /** 服务端鉴权 token；null 表示不校验。 */
  token: string | null
  /** 对比模式：把两份轨迹对照成一份报告（第一份为基准）。 */
  compare: boolean
  /** 口径对比：与另一套规则包（别名或文件）在本次轨迹上对跑。 */
  packCompare: string | null
  quiet: boolean
  help: boolean
  version: boolean
}

export interface CliDefaults {
  format: ReportFormat
  locale: Locale
  maxFiles: number
  maxFileBytes: number
}

export const CLI_DEFAULTS: CliDefaults = {
  format: 'both',
  locale: 'zh-CN',
  maxFiles: 500,
  maxFileBytes: 32 * 1024 * 1024,
}

export type UsageErrorCode =
  'unknown-flag' | 'missing-value' | 'invalid-format' | 'invalid-locale' | 'invalid-number' | 'no-paths'

export interface UsageError {
  code: UsageErrorCode
  /** 触发问题的选项名，例如 `--fail-below`。 */
  flag?: string
  /** 用户给的原值或范围说明。 */
  value?: string
  /** 数值类错误的合法区间，供文案拼装。 */
  range?: { min: number; max: number }
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: UsageError }

const FORMATS: ReportFormat[] = ['md', 'json', 'html', 'both', 'all']

function parseInteger(raw: string | undefined, flag: string, min: number, max: number): number | UsageError {
  if (raw === undefined) return { code: 'missing-value', flag }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return { code: 'invalid-number', flag, value: raw, range: { min, max } }
  }
  return value
}

/** `--flag=value` 拆两段；`--flag value` 由 `next()` 从队列里取。 */
function splitFlag(token: string): { flag: string; inline: string | undefined } {
  const index = token.indexOf('=')
  if (index < 0) return { flag: token, inline: undefined }
  return { flag: token.slice(0, index), inline: token.slice(index + 1) }
}

export interface ParseOptions {
  /** `qa serve` 不需要路径：它不是批量分析。 */
  allowNoPaths?: boolean
}

export function parseArgs(argv: string[], parseOptions: ParseOptions = {}): ParseResult {
  const options: CliOptions = {
    paths: [],
    format: CLI_DEFAULTS.format,
    out: null,
    locale: CLI_DEFAULTS.locale,
    pack: null,
    failBelow: null,
    maxFiles: CLI_DEFAULTS.maxFiles,
    maxFileBytes: CLI_DEFAULTS.maxFileBytes,
    semantic: false,
    llmUrl: null,
    llmModel: null,
    semanticLimit: 20,
    semanticDryRun: false,
    agent: false,
    agentDryRun: false,
    agentRounds: null,
    agentTrace: null,
    agentTask: null,
    serve: false,
    port: 7788,
    host: '127.0.0.1',
    token: null,
    compare: false,
    packCompare: null,
    quiet: false,
    help: false,
    version: false,
  }

  let index = 0
  let positionalOnly = false

  const takeValue = (inline: string | undefined, flag: string): string | UsageError => {
    if (inline !== undefined) return inline
    index += 1
    const next = argv[index]
    if (next === undefined || (next.startsWith('-') && next !== '-')) {
      return { code: 'missing-value', flag }
    }
    return next
  }

  while (index < argv.length) {
    const token = argv[index] as string

    if (positionalOnly || !token.startsWith('-') || token === '-') {
      options.paths.push(token)
      index += 1
      continue
    }

    if (token === '--') {
      positionalOnly = true
      index += 1
      continue
    }

    const { flag, inline } = splitFlag(token)
    switch (flag) {
      case '-h':
      case '--help':
        options.help = true
        index += 1
        break
      case '-v':
      case '--version':
        options.version = true
        index += 1
        break
      case '-q':
      case '--quiet':
        options.quiet = true
        index += 1
        break
      case '--format': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        if (!FORMATS.includes(value as ReportFormat)) {
          return { ok: false, error: { code: 'invalid-format', flag, value } }
        }
        options.format = value as ReportFormat
        index += 1
        break
      }
      case '--locale': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        if (!isLocale(value)) return { ok: false, error: { code: 'invalid-locale', flag, value } }
        options.locale = value
        index += 1
        break
      }
      case '--out': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.out = value
        index += 1
        break
      }
      case '--pack': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.pack = value
        index += 1
        break
      }
      case '--fail-below': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        const parsed = parseInteger(value, flag, 0, 100)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.failBelow = parsed
        index += 1
        break
      }
      case '--max-files': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        const parsed = parseInteger(value, flag, 1, 100_000)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.maxFiles = parsed
        index += 1
        break
      }
      case '--compare':
        options.compare = true
        index += 1
        break
      case '--pack-compare': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.packCompare = value
        index += 1
        break
      }
      case '--semantic':
        options.semantic = true
        index += 1
        break
      case '--semantic-dry-run':
        options.semantic = true
        options.semanticDryRun = true
        index += 1
        break
      case '--llm-url': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.llmUrl = value
        index += 1
        break
      }
      case '--llm-model': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.llmModel = value
        index += 1
        break
      }
      case '--semantic-limit': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        const parsed = parseInteger(value, flag, 1, 10_000)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.semanticLimit = parsed
        index += 1
        break
      }
      case '--max-bytes': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        const parsed = parseInteger(value, flag, 1, 2 ** 31)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.maxFileBytes = parsed
        index += 1
        break
      }
      case '--agent':
        options.agent = true
        index += 1
        break
      case '--agent-dry-run':
        options.agent = true
        options.agentDryRun = true
        index += 1
        break
      case '--agent-rounds': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        const parsed = parseInteger(value, flag, 2, 40)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.agent = true
        options.agentRounds = parsed
        index += 1
        break
      }
      case '--agent-trace': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.agent = true
        options.agentTrace = value
        index += 1
        break
      }
      case '--port': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        // 允许 0：交给系统分配空闲端口，`serve` 会打印真实端口。
        const parsed = parseInteger(value, flag, 0, 65535)
        if (typeof parsed !== 'number') return { ok: false, error: parsed }
        options.port = parsed
        index += 1
        break
      }
      case '--host': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.host = value
        index += 1
        break
      }
      case '--token': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.token = value
        index += 1
        break
      }
      case '--agent-task': {
        const value = takeValue(inline, flag)
        if (typeof value !== 'string') return { ok: false, error: value }
        options.agent = true
        options.agentTask = value
        index += 1
        break
      }
      default:
        return { ok: false, error: { code: 'unknown-flag', flag } }
    }
  }

  if (!options.help && !options.version && !parseOptions.allowNoPaths && options.paths.length === 0) {
    return { ok: false, error: { code: 'no-paths' } }
  }

  return { ok: true, options }
}
