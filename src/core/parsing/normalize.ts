/** Message normalisation: from provider-shaped JSON to one `Step`.
 *
 *  Every provider quirk lives here and nowhere else. The rule engine and the UI
 *  only ever see `Step`, so adding a format is an internal change to this module.
 */

import { estimateTokens } from '../estimate'
import type { Role, Step, StepTokens, ToolCall, ToolResult } from '../model'

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  gpt: 'assistant',
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

export { TOOL_RESULT_TYPES, TOOL_USE_TYPES }

export function normalizeRole(raw: unknown): Role {
  if (typeof raw !== 'string') return 'unknown'
  return ROLE_MAP[raw.trim().toLowerCase()] ?? 'unknown'
}

export function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

export function readTimestamp(record: Record<string, unknown>): number | undefined {
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
    const output = number(
      pick(source, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']),
    )
    const total = number(pick(source, ['total_tokens', 'totalTokens'])) || input + output
    if (total > 0) return { input, output, total }
  }
  if (typeof source === 'number' && source > 0) {
    return { input: 0, output: 0, total: source }
  }
  return undefined
}

/** 轨迹里的 `is_error` / `isError`。三态：true、false，或 undefined（什么都没说，或写了 null）。
 *  只有「没说」才轮得到正文前缀的启发式；折成 false 就等于把「没说」和「明确没出错」混为一谈。 */
function readErrorFlag(record: Record<string, unknown>): boolean | undefined {
  const value = record.is_error ?? record.isError
  return typeof value === 'boolean' ? value : undefined
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

  let args: unknown
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

  // Responses 的 function_call 同时带 `id`（条目 id）和 `call_id`（与输出配对的键），必须先取 call_id。
  const id = pick(value, ['call_id', 'id', 'tool_call_id', 'toolCallId', 'tool_use_id'])
  return {
    id: typeof id === 'string' ? id : undefined,
    name: name || 'unknown_tool',
    rawArgs,
    args,
    argsValid,
  }
}

export function readText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : '',
      )
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

    if (TEXT_PART_TYPES.has(type)) {
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
      draft.resultIsError = readErrorFlag(raw)
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

  // ShareGPT 把正文放在 `value` 里。只在没有 content 时才退到它。
  const content = message.content ?? message.value
  if (typeof content === 'string') draft.text = content
  else if (Array.isArray(content)) readParts(content, draft)
  else if (content !== undefined && content !== null) draft.text = readText(content)

  const reasoning = pick(message, ['reasoning_content', 'reasoning', 'thinking'])
  if (typeof reasoning === 'string') {
    draft.reasoning = draft.reasoning ? `${draft.reasoning}\n${reasoning}` : reasoning
  }

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

/** LangChain 的类名 → 角色。id 数组的最后一项就是类名。 */
const LANGCHAIN_CLASS_ROLE: Record<string, Role> = {
  humanmessage: 'user',
  aimessage: 'assistant',
  aimessagechunk: 'assistant',
  systemmessage: 'system',
  toolmessage: 'tool',
  functionmessage: 'tool',
}

/** `type` 字段当角色用时认哪些：LangChain 的 model_dump() / messages_to_dict() 都这么写。 */
const TYPE_AS_ROLE = new Set(['human', 'ai', 'system', 'tool', 'function'])

function isLangChainConstructor(value: Record<string, unknown>): boolean {
  return value.lc !== undefined && isRecord(value.kwargs) && Array.isArray(value.id)
}

/** 把 LangChain 的两种外壳剥成普通消息，其余原样返回。
 *  - 构造器形式 {lc, type:'constructor', id:[…,'HumanMessage'], kwargs:{content}}：角色来自类名；
 *  - messages_to_dict 形式 {type:'human', data:{content, …}}：负载在 data 里。
 *  只在确认是这两种壳时才动手，所以一条普通消息恰好带个 data 字段不会被误剥。 */
export function unwrapMessage(value: Record<string, unknown>): Record<string, unknown> {
  if (isLangChainConstructor(value)) {
    const kwargs = value.kwargs as Record<string, unknown>
    const cls = String((value.id as unknown[]).at(-1) ?? '').toLowerCase()
    const role = LANGCHAIN_CLASS_ROLE[cls]
    return role ? { role, ...kwargs } : kwargs
  }
  if (
    typeof value.type === 'string' &&
    TYPE_AS_ROLE.has(value.type.toLowerCase()) &&
    typeof value.role !== 'string' &&
    isRecord(value.data)
  ) {
    return { ...value.data, type: value.type }
  }
  return value
}

export function looksLikeMessage(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.role === 'string') return true
  if (isLangChainConstructor(value)) return true
  if (typeof value.type === 'string' && TYPE_AS_ROLE.has(value.type.toLowerCase())) return true
  // ShareGPT：{from, value}
  if (typeof value.from === 'string' && typeof value.value === 'string') return true
  if (
    typeof value.type === 'string' &&
    (TOOL_USE_TYPES.has(value.type) || TOOL_RESULT_TYPES.has(value.type))
  ) {
    return true
  }
  return 'content' in value || 'tool_calls' in value
}

export function toStep(raw: unknown, index: number): Step {
  const notes: string[] = []

  if (!isRecord(raw)) {
    const text = readText(raw)
    return {
      index,
      role: 'unknown',
      text,
      reasoning: '',
      toolCalls: [],
      tokens: { input: 0, output: 0, total: estimateTokens(text), estimated: true },
      charCount: text.length,
      raw,
      parseNotes: ['消息不是对象，已按纯文本处理'],
    }
  }

  // 剥掉 LangChain 的外壳；`raw`（原样保留在 Step 上给检视器看）仍是剥之前的对象，
  // 下面读字段一律用 `source`。
  const source = unwrapMessage(raw)
  const type = typeof source.type === 'string' ? source.type : ''
  let role = normalizeRole(pick(source, ['role', 'sender', 'author', 'from', 'speaker']))
  // LangChain 把角色写在 `type` 里。只在没有显式角色时才用，所以不会盖过 role 字段。
  if (role === 'unknown' && TYPE_AS_ROLE.has(type.toLowerCase())) {
    role = normalizeRole(type.toLowerCase() === 'ai' ? 'assistant' : type)
  }
  if (role === 'unknown' && TOOL_USE_TYPES.has(type)) role = 'assistant'
  if (role === 'unknown' && TOOL_RESULT_TYPES.has(type)) role = 'tool'

  const draft = readContentDraft(source)
  // Anthropic-style traces put `tool_result` parts on a user message.
  if (draft.resultContent !== undefined && role !== 'tool') role = 'tool'

  // OpenAI Responses items carry the call/result on the item itself.
  if (TOOL_USE_TYPES.has(type) && !isRecord(source.function) && draft.calls.length === 0) {
    const call = toCallDraft(source, notes)
    if (call) draft.calls.push(call)
  }

  let result: ToolResult | undefined
  if (role === 'tool' || TOOL_RESULT_TYPES.has(type)) {
    const callIdRaw = pick(source, ['tool_call_id', 'toolCallId', 'call_id', 'tool_use_id'])
    const noteCallId = draft.notes.find((note) => note.startsWith('RESULT_CALL_ID:'))
    const callId =
      typeof callIdRaw === 'string' ? callIdRaw : noteCallId ? noteCallId.slice('RESULT_CALL_ID:'.length) : ''
    const content = draft.resultContent ?? readText(pick(source, ['content', 'output', 'result', 'value']))
    // 显式标记优先：轨迹明确说了 is_error（真或假）就以它为准。只有它什么都没说时，
    // 才退到「正文以 Error / Exception / Traceback 开头」的启发式。
    // 此前两者是 `||`，一份叫「Error handling guide」的文档即使被明确标成 is_error:false 也算出错。
    const explicit = readErrorFlag(source) ?? draft.resultIsError
    const isError = explicit ?? /^\s*(error|exception|traceback)\b/i.test(content)
    result = {
      callId,
      name: typeof source.name === 'string' ? source.name : undefined,
      content,
      isError,
      timestamp: readTimestamp(source),
    }
  }

  const usage = readUsage(source)
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
    timestamp: readTimestamp(source),
    tokens,
    charCount:
      draft.text.length +
      draft.reasoning.length +
      toolCalls.reduce((s, c) => s + c.rawArgs.length, 0) +
      (result?.content.length ?? 0),
    raw,
    parseNotes: [...draft.notes.filter((note) => !note.startsWith('RESULT_CALL_ID:')), ...notes],
  }
}

function isToolResultPart(part: unknown): boolean {
  return isRecord(part) && typeof part.type === 'string' && TOOL_RESULT_TYPES.has(part.type)
}

/** One raw message → one or more steps.
 *
 *  A `Step` carries a single result, but Anthropic puts every parallel `tool_result`
 *  of a turn into one user message. Reading them into one step would keep only the
 *  last content and pair it with the first id, so such a message is split: one step
 *  per result, plus one for whatever else the message held. */
export function toSteps(raw: unknown, index: number): Step[] {
  const parts = isRecord(raw) && Array.isArray(raw.content) ? raw.content : undefined
  if (!isRecord(raw) || !parts || parts.filter(isToolResultPart).length < 2) return [toStep(raw, index)]

  const note = '一条消息含多个 tool_result，已拆成独立步骤'
  const steps: Step[] = []

  const rest = parts.filter((part) => !isToolResultPart(part))
  const hasCalls = pick(raw, ['tool_calls', 'toolCalls']) !== undefined || isRecord(raw.function_call)
  if (rest.length > 0 || hasCalls) {
    const step = toStep({ ...raw, content: rest }, index)
    step.raw = raw
    step.parseNotes.push(note)
    steps.push(step)
  }

  const timestamp = readTimestamp(raw)
  for (const part of parts.filter(isToolResultPart)) {
    const step = toStep(
      { role: 'tool', content: [part], ...(timestamp !== undefined && { timestamp }) },
      index,
    )
    step.raw = part
    step.parseNotes.push(note)
    steps.push(step)
  }
  return steps
}

/** Pairs tool results to calls. Only falls back to name matching when the trace
 *  gave no id at all — a dangling id is reported, never silently re-pointed. */
export function pairToolResults(steps: Step[], notes: string[]): void {
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
