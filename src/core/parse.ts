/** Trajectory parsing: from "some JSON file" to a normalized Step list.
 *
 *  Supported shapes (all auto-detected, no user choice required):
 *    - OpenAI chat messages: array, `{messages:[...]}`, `{data:{messages:[...]}}`
 *    - JSONL: one message per line, or one session per line
 *    - Multiple sessions: array of objects each holding a messages/steps array
 *    - OpenAI Responses-style items: `function_call` / `function_call_output`
 *    - Anthropic-style content parts: `tool_use` / `tool_result`
 *
 *  The parser is intentionally forgiving: a malformed tool argument becomes a
 *  `argsValid: false` finding rather than a hard failure, because the tool's
 *  job is to *inspect* broken traces, not to refuse them.
 */

import { estimateTokens } from './estimate'
import type { Role, Step, StepTokens, ToolCall, ToolResult, Trajectory } from './types'

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ROLE_MAP: Record<string, Role> = {
  system: 'system',
  developer: 'developer',
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  bot: 'assistant',
  model: 'assistant',
  agent: 'assistant',
  tool: 'tool',
  function: 'tool',
  tool_result: 'tool',
  'tool-result': 'tool',
  observation: 'tool',
}

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text', 'message'])
const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image', 'image_url_detail'])
const REASONING_PART_TYPES = new Set(['thinking', 'reasoning', 'reasoning_content'])
const TOOL_USE_TYPES = new Set(['tool_use', 'tool_call', 'function_call'])
const TOOL_RESULT_TYPES = new Set(['tool_result', 'function_call_output', 'tool_response'])

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

function normalizeRole(raw: unknown): Role {
  if (typeof raw !== 'string') return 'unknown'
  return ROLE_MAP[raw.trim().toLowerCase()] ?? 'unknown'
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

function readTimestamp(record: Record<string, unknown>): number | undefined {
  const raw = pick(record, ['timestamp', 'ts', 'time', 'created', 'created_at', 'createdAt'])
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

interface Usage {
  input: number
  output: number
  total: number
}

function readUsage(record: Record<string, unknown>): Usage | undefined {
  const source = pick(record, ['usage', 'token_usage', 'usage_metadata', 'tokens'])
  if (isRecord(source)) {
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const input = number(pick(source, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']))
    const output = number(pick(source, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']))
    const total = number(pick(source, ['total_tokens', 'totalTokens'])) || input + output
    if (total > 0) return { input, output, total }
  }
  if (typeof source === 'number' && source > 0) {
    return { input: 0, output: 0, total: source }
  }
  return undefined
}

interface CallDraft {
  id?: string
  name: string
  rawArgs: string
  args: unknown
  argsValid: boolean
}

interface ContentDraft {
  text: string
  reasoning: string
  calls: CallDraft[]
  resultContent?: string
  resultIsError?: boolean
  notes: string[]
}

function toCallDraft(value: unknown, notes: string[]): CallDraft | undefined {
  if (!isRecord(value)) {
    notes.push('忽略了一个非对象的 tool_call')
    return undefined
  }
  const fn = isRecord(value.function) ? value.function : value
  const name = String(pick(fn, ['name', 'tool_name', 'toolName']) ?? value.name ?? '').trim()
  if (!name) notes.push('发现一个缺少函数名的 tool_call')

  const rawArgsValue = pick(fn, ['arguments', 'args', 'input']) ?? pick(value, ['arguments', 'args', 'input'])
  let rawArgs = ''
  if (typeof rawArgsValue === 'string') rawArgs = rawArgsValue
  else if (rawArgsValue !== undefined) rawArgs = JSON.stringify(rawArgsValue)

  let args: unknown = {}
  let argsValid = true
  if (rawArgs.trim() === '') {
    args = {}
  } else {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      args = rawArgs
      argsValid = false
    }
  }

  const id = pick(value, ['id', 'call_id', 'tool_call_id', 'toolCallId', 'tool_use_id'])
  return {
    id: typeof id === 'string' ? id : undefined,
    name: name || 'unknown_tool',
    rawArgs,
    args,
    argsValid,
  }
}

function readText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (isRecord(value)) {
    const nested = pick(value, ['text', 'content', 'output', 'result'])
    if (typeof nested === 'string') return nested
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function readParts(parts: unknown[], draft: ContentDraft): void {
  for (const raw of parts) {
    if (typeof raw === 'string') {
      draft.text += raw
      continue
    }
    if (!isRecord(raw)) {
      draft.notes.push('忽略了无法识别的内容片段')
      continue
    }

    const type = typeof raw.type === 'string' ? raw.type : ''
    if (type === '' && typeof raw.text === 'string') {
      draft.text += raw.text
      continue
    }

    if (TEXT_PART_TYPES.has(type) || (type === '' && typeof raw.text === 'string')) {
      draft.text += readText(raw.text)
      continue
    }
    if (IMAGE_PART_TYPES.has(type)) {
      draft.notes.push('含图片/多模态片段（未解析内容）')
      draft.text += '[图片]'
      continue
    }
    if (REASONING_PART_TYPES.has(type)) {
      draft.reasoning += readText(raw.text ?? raw.thinking ?? raw.reasoning)
      continue
    }
    if (TOOL_USE_TYPES.has(type)) {
      const call = toCallDraft({ ...raw, function: isRecord(raw.function) ? raw.function : raw }, draft.notes)
      if (call) draft.calls.push(call)
      continue
    }
    if (TOOL_RESULT_TYPES.has(type)) {
      draft.resultContent = readText(raw.content ?? raw.output ?? raw.result)
      draft.resultIsError = Boolean(raw.is_error ?? raw.isError)
      const callId = pick(raw, ['tool_use_id', 'tool_call_id', 'call_id', 'id'])
      if (typeof callId === 'string') draft.notes.push(`RESULT_CALL_ID:${callId}`)
      continue
    }
    if (typeof raw.text === 'string') {
      draft.text += raw.text
      draft.notes.push(`未知片段类型 "${type || '空'}"，已按纯文本读取`)
      continue
    }
    draft.notes.push(`忽略未知片段类型 "${type || '空'}"`)
  }
}

function readContentDraft(message: Record<string, unknown>): ContentDraft {
  const draft: ContentDraft = { text: '', reasoning: '', calls: [], notes: [] }

  const content = message.content
  if (typeof content === 'string') draft.text = content
  else if (Array.isArray(content)) readParts(content, draft)
  else if (content !== undefined && content !== null) draft.text = readText(content)

  const reasoning = pick(message, ['reasoning_content', 'reasoning', 'thinking'])
  if (typeof reasoning === 'string') draft.reasoning = draft.reasoning ? `${draft.reasoning}\n${reasoning}` : reasoning

  const rawCalls = pick(message, ['tool_calls', 'toolCalls'])
  if (Array.isArray(rawCalls)) {
    for (const item of rawCalls) {
      const call = toCallDraft(item, draft.notes)
      if (call) draft.calls.push(call)
    }
  }
  const legacy = message.function_call
  if (isRecord(legacy)) {
    const call = toCallDraft({ function: legacy, id: legacy.id }, draft.notes)
    if (call) draft.calls.push(call)
  }

  return draft
}

function looksLikeMessage(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.role === 'string') return true
  if (typeof value.type === 'string' && (TOOL_USE_TYPES.has(value.type) || TOOL_RESULT_TYPES.has(value.type))) {
    return true
  }
  return 'content' in value || 'tool_calls' in value
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

interface SessionDraft {
  messages: unknown[]
  meta: Record<string, unknown>
}

function detectSessions(value: unknown): SessionDraft[] {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new ParseError('轨迹为空')
    if (value.every(looksLikeMessage)) return [{ messages: value, meta: {} }]
    if (value.every((item) => Array.isArray(item))) {
      return value.map((item) => ({ messages: item as unknown[], meta: {} }))
    }
    const sessions = value.filter((item) => isRecord(item) && findMessageArray(item))
    if (sessions.length > 0) {
      return value.map((item) => {
        const messages = findMessageArray(item)
        return {
          messages: messages ?? [item],
          meta: isRecord(item) ? item : {},
        }
      })
    }
    return [{ messages: value, meta: {} }]
  }

  if (isRecord(value)) {
    const messages = findMessageArray(value)
    if (messages) return [{ messages, meta: value }]
    if (looksLikeMessage(value)) return [{ messages: [value], meta: {} }]
  }

  throw new ParseError('结构无法识别：未找到 messages / steps 数组')
}

function parseLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new ParseError('输入为空')
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length <= 1) throw new ParseError('不是合法的 JSON')
    const parsed: unknown[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string
      try {
        parsed.push(JSON.parse(line))
      } catch {
        throw new ParseError(`JSONL 第 ${i + 1} 行不是合法 JSON`)
      }
    }
    return parsed
  }
}

function stepFromMessage(raw: unknown, index: number): Step {
  const notes: string[] = []

  if (!isRecord(raw)) {
    return {
      index,
      role: 'unknown',
      text: readText(raw),
      reasoning: '',
      toolCalls: [],
      tokens: { input: 0, output: 0, total: estimateTokens(readText(raw)), estimated: true },
      charCount: readText(raw).length,
      raw,
      parseNotes: ['消息不是对象，已按纯文本处理'],
    }
  }

  const type = typeof raw.type === 'string' ? raw.type : ''
  let role = normalizeRole(pick(raw, ['role', 'sender', 'author', 'from', 'speaker']))
  if (role === 'unknown' && TOOL_USE_TYPES.has(type)) role = 'assistant'
  if (role === 'unknown' && TOOL_RESULT_TYPES.has(type)) role = 'tool'

  const draft = readContentDraft(raw)
  // Anthropic-style traces put `tool_result` parts on a user message.
  if (draft.resultContent !== undefined && role !== 'tool') role = 'tool'

  // OpenAI Responses items carry the call/result on the item itself.
  if (TOOL_USE_TYPES.has(type) && !isRecord(raw.function) && draft.calls.length === 0) {
    const call = toCallDraft(raw, notes)
    if (call) draft.calls.push(call)
  }

  let result: ToolResult | undefined
  if (role === 'tool' || TOOL_RESULT_TYPES.has(type)) {
    const callIdRaw = pick(raw, ['tool_call_id', 'toolCallId', 'call_id', 'tool_use_id'])
    const noteCallId = draft.notes.find((note) => note.startsWith('RESULT_CALL_ID:'))
    const callId =
      typeof callIdRaw === 'string'
        ? callIdRaw
        : noteCallId
          ? noteCallId.slice('RESULT_CALL_ID:'.length)
          : ''
    const content = draft.resultContent ?? readText(pick(raw, ['content', 'output', 'result']))
    const flagError = Boolean(raw.is_error ?? raw.isError) || Boolean(draft.resultIsError)
    const prefixedError = /^\s*(error|exception|traceback)\b/i.test(content)
    result = {
      callId,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      content,
      isError: flagError || prefixedError,
      timestamp: readTimestamp(raw),
    }
  }

  const usage = readUsage(raw)
  const textTokens = estimateTokens(draft.text) + estimateTokens(draft.reasoning)
  const callTokens = draft.calls.reduce((sum, call) => sum + estimateTokens(call.rawArgs), 0)
  const resultTokens = estimateTokens(result?.content ?? '')
  const estimatedTotal = textTokens + callTokens + resultTokens

  const tokens: StepTokens = usage
    ? { input: usage.input, output: usage.output, total: usage.total, estimated: false }
    : { input: 0, output: 0, total: estimatedTotal, estimated: true }

  const toolCalls: ToolCall[] = draft.calls.map((call, i) => ({
    id: call.id ?? `call-${index}-${i}`,
    name: call.name,
    rawArgs: call.rawArgs,
    args: call.args,
    argsValid: call.argsValid,
  }))

  if (draft.calls.some((call) => !call.argsValid)) notes.push('存在非法 JSON 的工具参数')

  return {
    index,
    role,
    text: draft.text,
    reasoning: draft.reasoning,
    toolCalls,
    result,
    timestamp: readTimestamp(raw),
    tokens,
    charCount: draft.text.length + draft.reasoning.length + toolCalls.reduce((s, c) => s + c.rawArgs.length, 0) + (result?.content.length ?? 0),
    raw,
    parseNotes: [...draft.notes.filter((note) => !note.startsWith('RESULT_CALL_ID:')), ...notes],
  }
}

function pairToolResults(steps: Step[], notes: string[]): void {
  const byId = new Map<string, ToolCall>()
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (call.id && !byId.has(call.id)) byId.set(call.id, call)
    }
  }

  const unpairedCalls = () => {
    const list: ToolCall[] = []
    for (const step of steps) for (const call of step.toolCalls) if (!call.result) list.push(call)
    return list
  }

  for (const step of steps) {
    if (!step.result) continue
    const { callId } = step.result
    const direct = callId ? byId.get(callId) : undefined
    if (direct && !direct.result) {
      direct.result = step.result
      step.forCallId = callId
      continue
    }
    // Fall back to name matching only when the id is missing; never guess when
    // the trace gave us an id that points nowhere.
    if (!callId && step.result.name) {
      const match = unpairedCalls().find((call) => call.name === step.result?.name)
      if (match) {
        match.result = step.result
        step.forCallId = match.id
        notes.push(`第 ${step.index + 1} 步的工具结果按函数名配对到 ${match.id}`)
        continue
      }
    }
    if (callId) notes.push(`第 ${step.index + 1} 步的工具结果指向不存在的调用 ${callId}`)
  }
}

export function parseTrajectory(input: string, sourceLabel = '未命名轨迹'): Trajectory[] {
  const value = parseLoose(input)
  const drafts = detectSessions(value)

  return drafts.map((draft, sessionIndex) => {
    const notes: string[] = []
    const steps = draft.messages.map(stepFromMessage)
    steps.forEach((step, index) => {
      step.index = index
    })
    pairToolResults(steps, notes)

    const timestamps = steps.map((step) => step.timestamp).filter((ts): ts is number => ts !== undefined)
    const metaSource = draft.meta
    const modelRaw = pick(metaSource, ['model', 'model_name', 'modelName', 'model_id'])
    const labelRaw = pick(metaSource, ['title', 'name', 'session_id', 'sessionId', 'id', 'file_name'])
    const totalTokens = steps.reduce((sum, step) => sum + step.tokens.total, 0)

    const idBase =
      (typeof labelRaw === 'string' ? labelRaw : `${sourceLabel}#${sessionIndex + 1}`)
        .replace(/\s+/g, '-')
        .slice(0, 60) || `session-${sessionIndex + 1}`

    return {
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
    }
  })
}
