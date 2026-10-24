/** Trajectory parsing — the only entry point that turns text into `Trajectory[]`.
 *
 *  Supported shapes (auto-detected):
 *    - OpenAI chat messages: array, `{messages:[…]}`, `{data:{messages:[…]}}`
 *    - JSONL: one message per line, or one session per line
 *    - Multiple sessions: array of objects each holding a messages/steps array
 *    - OpenAI Responses items: `function_call` / `function_call_output`
 *    - Anthropic content parts: `tool_use` / `tool_result`
 *
 *  The parser is forgiving by design — a malformed tool argument becomes a
 *  finding, not a failure — but structural impossibilities return a `Result`
 *  instead of throwing, so callers never have to try/catch across a seam.
 */

import { fail, ok, type Result, type Trajectory } from '../model'
import { isRecord, looksLikeMessage, pairToolResults, pick, toSteps } from './normalize'

const CONTAINER_KEYS = [
  'messages',
  'steps',
  'trajectory',
  'conversation',
  'history',
  'transcript',
  'turns',
  'items',
  'events',
  'log',
]

const NESTED_KEYS = ['data', 'result', 'payload', 'session', 'record', 'thread', 'run']

export const DEFAULT_MAX_STEPS = 20_000

interface SessionDraft {
  messages: unknown[]
  meta: Record<string, unknown>
}

function findMessageArray(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) return undefined
  for (const key of CONTAINER_KEYS) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate
  }
  for (const key of NESTED_KEYS) {
    const nested = value[key]
    if (isRecord(nested)) {
      const found = findMessageArray(nested)
      if (found) return found
    }
  }
  return undefined
}

export function detectSessions(value: unknown): Result<SessionDraft[]> {
  if (Array.isArray(value)) {
    if (value.length === 0) return fail('empty-input', '轨迹为空')
    if (value.every(looksLikeMessage)) return ok([{ messages: value, meta: {} }])
    if (value.every((item) => Array.isArray(item))) {
      return ok(value.map((item) => ({ messages: item as unknown[], meta: {} })))
    }
    const sessions = value.filter((item) => isRecord(item) && findMessageArray(item))
    if (sessions.length > 0) {
      return ok(
        value.map((item) => {
          const messages = findMessageArray(item)
          return { messages: messages ?? [item], meta: isRecord(item) ? item : {} }
        }),
      )
    }
    return ok([{ messages: value, meta: {} }])
  }

  if (isRecord(value)) {
    const messages = findMessageArray(value)
    if (messages) return ok([{ messages, meta: value }])
    if (looksLikeMessage(value)) return ok([{ messages: [value], meta: {} }])
  }

  return fail('unrecognized-structure', '结构无法识别：未找到 messages / steps 数组')
}

export function parseLoose(text: string): Result<unknown> {
  const trimmed = text.trim()
  if (!trimmed) return fail('empty-input', '输入为空')

  try {
    return ok(JSON.parse(trimmed))
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length <= 1) return fail('invalid-json', '不是合法的 JSON')
    const parsed: unknown[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string
      try {
        parsed.push(JSON.parse(line))
      } catch {
        return fail('invalid-json', `JSONL 第 ${i + 1} 行不是合法 JSON`, { line: i + 1 })
      }
    }
    return ok(parsed)
  }
}

export interface ParseOptions {
  maxSteps?: number
}

export function parseTrajectory(
  input: string,
  sourceLabel = '未命名轨迹',
  options: ParseOptions = {},
): Result<Trajectory[]> {
  const parsed = parseLoose(input)
  if (!parsed.ok) return parsed

  const sessions = detectSessions(parsed.value)
  if (!sessions.ok) return sessions

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const drafts = sessions.value

  const trajectories: Trajectory[] = []
  for (let sessionIndex = 0; sessionIndex < drafts.length; sessionIndex += 1) {
    const draft = drafts[sessionIndex] as SessionDraft
    if (draft.messages.length > maxSteps) {
      return fail('too-many-steps', `会话 ${sessionIndex + 1} 超过步数上限 ${maxSteps}`, {
        session: sessionIndex + 1,
        steps: draft.messages.length,
      })
    }

    const notes: string[] = []
    const steps = draft.messages.flatMap(toSteps)
    steps.forEach((step, index) => {
      step.index = index
    })
    pairToolResults(steps, notes)

    const timestamps = steps.map((step) => step.timestamp).filter((ts): ts is number => ts !== undefined)
    const modelRaw = pick(draft.meta, ['model', 'model_name', 'modelName', 'model_id'])
    const labelRaw = pick(draft.meta, ['title', 'name', 'session_id', 'sessionId', 'id', 'file_name'])
    const totalTokens = steps.reduce((sum, step) => sum + step.tokens.total, 0)

    const idBase =
      (typeof labelRaw === 'string' ? labelRaw : `${sourceLabel}#${sessionIndex + 1}`)
        .replace(/\s+/g, '-')
        .slice(0, 60) || `session-${sessionIndex + 1}`

    trajectories.push({
      id: `${idBase}-${sessionIndex}`,
      label:
        typeof labelRaw === 'string'
          ? labelRaw
          : drafts.length > 1
            ? `${sourceLabel} · 会话 ${sessionIndex + 1}`
            : sourceLabel,
      source: sourceLabel,
      steps,
      meta: {
        model: typeof modelRaw === 'string' ? modelRaw : undefined,
        startedAt: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
        endedAt: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
        totalTokens,
        estimatedTokens: steps.some((step) => step.tokens.estimated),
      },
      parseNotes: notes,
    })
  }

  return ok(trajectories)
}
