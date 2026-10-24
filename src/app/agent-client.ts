/** 界面这边唯一的网络出口：把会话递给本机服务，把进度与结论读回来。
 *
 *  三条约束：
 *  1. **只在用户点了「诊断」时才发请求**。不探测、不预取——离线承诺不是靠嘴说的。
 *  2. **不碰密钥**。端点与 token 都从 URL 查询参数读；真正的 API key 在服务进程里。
 *  3. **只发服务端需要的字段**。`step.raw` 是解析前的原始对象，常常比整条轨迹还大，
 *     发过去纯属浪费带宽——这也正是「本地传输」最容易忽略的成本。
 */

import type { SessionAnalysis } from '../core/analysis'
import type { RulePack, Step } from '../core/model'
import type { AgentEvent, AgentRun } from '../core/agent/types'

export interface AgentTarget {
  /** 形如 `http://127.0.0.1:7788`，末尾不带斜杠。 */
  endpoint: string
  token: string | null
}

/** `?agent=http://127.0.0.1:7788&agentToken=xxx`；没有 `agent` 就视为未配置。 */
export function readAgentTarget(search: string): AgentTarget | null {
  const params = new URLSearchParams(search)
  const endpoint = params.get('agent')
  if (!endpoint) return null
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  return trimmed === '' ? null : { endpoint: trimmed, token: params.get('agentToken') }
}

function stripStep(step: Step): Omit<Step, 'raw'> {
  const { raw: _raw, ...rest } = step
  return rest
}

export interface DiagnoseRequest {
  target: AgentTarget
  sessions: SessionAnalysis[]
  pack: RulePack
  task?: string
  rounds?: number
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

export type DiagnoseFailureCode = 'offline' | 'http' | 'stream' | 'aborted' | 'rejected'

export type DiagnoseOutcome =
  /** `partial` 非空表示服务端跳过了几条会话（不变量 5 的会话级隔离），界面要如实显示。
   *  `model` 来自 start 事件：导出的报告要写清真用了哪个模型。 */
  | { ok: true; run: AgentRun; model: string; partial?: string }
  | { ok: false; code: DiagnoseFailureCode; message: string }

interface StreamLine {
  type: string
  event?: AgentEvent
  run?: AgentRun
  message?: string
  code?: string
}

/** 服务端把错误放在 JSON 里；读不出来就退回状态码，别把整页 HTML 塞给用户。 */
function messageFrom(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error
  } catch {
    // 不是 JSON：多半是代理或框架的错误页
  }
  return `HTTP ${status}`
}

export async function diagnose(request: DiagnoseRequest): Promise<DiagnoseOutcome> {
  const payload = {
    sessions: request.sessions.map((session) => ({
      id: session.id,
      label: session.trajectory.label,
      meta: session.trajectory.meta,
      steps: session.trajectory.steps.map(stripStep),
    })),
    pack: request.pack,
    task: request.task,
    rounds: request.rounds,
  }

  let response: Response
  try {
    response = await fetch(`${request.target.endpoint}/api/diagnose`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.target.token ? { 'x-tqa-token': request.target.token } : {}),
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    })
  } catch (error) {
    if (request.signal?.aborted) return { ok: false, code: 'aborted', message: 'aborted' }
    // 浏览器的 fetch 失败只有 "Failed to fetch" 一句话，分不清「服务没起」和「端口写错」。
    return { ok: false, code: 'offline', message: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, code: 'http', message: messageFrom(text, response.status) }
  }

  const reader = response.body?.getReader()
  if (!reader) return { ok: false, code: 'stream', message: 'response has no body' }

  const decoder = new TextDecoder()
  let buffer = ''
  let run: AgentRun | null = null
  let partial: string | null = null
  let streamError: string | null = null
  let model = ''

  const handle = (line: string): void => {
    let parsed: StreamLine
    try {
      parsed = JSON.parse(line) as StreamLine
    } catch {
      // 半行或坏行：跳过，不要让一行脏数据毁掉整次诊断
      return
    }
    if (parsed.type === 'start') model = (parsed as { model?: string }).model ?? ''
    else if (parsed.type === 'progress' && parsed.event) request.onEvent?.(parsed.event)
    else if (parsed.type === 'done' && parsed.run) run = parsed.run
    else if (parsed.type === 'error') {
      // 服务端用 error 事件报「部分会话被跳过」，那不等于整次失败，所以分开记。
      if (parsed.code === 'partial') partial = parsed.message ?? null
      else streamError = parsed.message ?? 'stream error'
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') handle(line)
        index = buffer.indexOf('\n')
      }
    }
  } catch (error) {
    if (request.signal?.aborted) return { ok: false, code: 'aborted', message: 'aborted' }
    return { ok: false, code: 'stream', message: error instanceof Error ? error.message : String(error) }
  }

  if (!run) {
    return { ok: false, code: streamError ? 'rejected' : 'stream', message: streamError ?? 'stream ended early' }
  }
  // 部分会话被跳过时如实交代：静默少诊断几条，等于让人以为都看过了。
  return partial === null ? { ok: true, run, model } : { ok: true, run, model, partial }
}
