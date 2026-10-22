/** Domain model for the trajectory quality console.
 *
 *  The model is deliberately flat and lossless-ish: every source message keeps
 *  its `raw` payload, while the normalized fields are what rules and views read.
 *  Rules never touch `raw` — that keeps them stable across provider formats.
 */

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
