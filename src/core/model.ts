/** The domain model — the single vocabulary every other module speaks.
 *
 *  Nothing in this file imports UI, DOM, storage or parsing code. If a change
 *  needs a new concept, it is named here first; that is what keeps the seams
 *  stable as the tool grows.
 */

// ---------- results ----------

export type ErrorCode =
  | 'empty-input'
  | 'invalid-json'
  | 'unrecognized-structure'
  | 'too-large'
  | 'too-many-steps'
  | 'invalid-pack'
  | 'analysis-failed'
  | 'read-failed'
  | 'aborted'

export interface AppError {
  code: ErrorCode
  message: string
  /** Optional machine-readable context (line number, file name, rule id…). */
  detail?: Record<string, unknown>
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T>(code: ErrorCode, message: string, detail?: Record<string, unknown>): Result<T> {
  return { ok: false, error: detail ? { code, message, detail } : { code, message } }
}

// ---------- trajectory ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer' | 'unknown'

export type Severity = 'error' | 'warn' | 'info'

export interface ToolResult {
  callId: string
  name?: string
  content: string
  isError: boolean
  timestamp?: number
}

export interface ToolCall {
  id: string
  name: string
  rawArgs: string
  args: unknown
  /** false when `rawArgs` is not valid JSON — a real, common corruption. */
  argsValid: boolean
  result?: ToolResult
}

export interface StepTokens {
  input: number
  output: number
  total: number
  /** true when `total` was inferred from character counts, not reported. */
  estimated: boolean
}

export interface Step {
  index: number
  role: Role
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  /** Present on role === 'tool' steps. */
  result?: ToolResult
  /** Present on role === 'tool' steps when the result was paired to a call. */
  forCallId?: string
  timestamp?: number
  tokens: StepTokens
  charCount: number
  raw: unknown
  parseNotes: string[]
}

export interface TrajectoryMeta {
  model?: string
  startedAt?: number
  endedAt?: number
  totalTokens: number
  estimatedTokens: boolean
}

export interface Trajectory {
  id: string
  label: string
  source: string
  steps: Step[]
  meta: TrajectoryMeta
  parseNotes: string[]
}

// ---------- rules ----------

export interface Dimension {
  id: string
  label: string
  weight: number
  color: string
  description: string
}

export interface Rule {
  id: string
  dimension: string
  severity: Severity
  title: string
  scoreImpact: number
  scope: 'step' | 'trajectory'
  expr: string
  message: string
  enabled: boolean
  builtin: boolean
}

export interface RulePack {
  version: number
  name: string
  dimensions: Dimension[]
  rules: Rule[]
}

export interface Finding {
  id: string
  ruleId: string
  ruleTitle: string
  dimension: string
  severity: Severity
  message: string
  stepIndex?: number
  evidence?: string
  impact: number
  manual?: boolean
}

export interface RuleIssue {
  ruleId: string
  message: string
}

export interface Annotation {
  id: string
  trajectoryId: string
  stepIndex?: number
  dimension: string
  severity: Severity
  note: string
}

// ---------- scores ----------

export interface SeverityCounts {
  error: number
  warn: number
  info: number
}

export const SEVERITY_FACTOR: Record<Severity, number> = {
  error: 1,
  warn: 0.65,
  info: 0.3,
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: '严重',
  warn: '警告',
  info: '提示',
}

export const ROLE_LABEL: Record<Role, string> = {
  system: '系统',
  developer: '开发',
  user: '用户',
  assistant: '助手',
  tool: '工具',
  unknown: '未知',
}
