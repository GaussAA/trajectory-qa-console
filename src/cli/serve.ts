/** 本地诊断服务：界面调本机，密钥留在服务进程里（ADR-0011 写明的形态）。
 *
 *  三条边界，缺一条这个形态就站不住：
 *  1. **只 bind 127.0.0.1**。局域网里的其他机器连不上；`0.0.0.0` 是不可接受的默认值。
 *  2. **CORS 白名单**：只放行 `file://`（Origin 为 `null`，单文件双击打开就是这种）与本机 http。
 *     其它来源一律不给 CORS 头——浏览器会拦下读取，恶意站点拿不到诊断结果。
 *  3. **可选 token**：跨站页面仍然能"盲发"请求消耗额度，token 拦的是这个。
 *     启动时打印，前端从 `?agentToken=` 读一次。
 *
 *  流式用 NDJSON 而不是 SSE：POST 请求配 `EventSource` 用不了，还得再写一套手动解析，
 *  不如直接用 fetch + 按行读，前端实现更短。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { computeMetrics, type SessionAnalysis } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { validatePack } from '../core/rules/contract'
import { runAgent } from '../core/agent'
import { fetchTransport, type LlmTransport } from '../core/llm/transport'
import type { RulePack, Step, Trajectory, TrajectoryMeta } from '../core/model'
import type { Locale } from '../i18n/core'
import type { SemanticConfig } from './llm-config'

export interface ServeConfig {
  llm: SemanticConfig
  /** 鉴权 token；null 表示不校验（仅本机、且用户明确关掉时）。 */
  token: string | null
  transport?: LlmTransport
  locale?: Locale
  /** 单次诊断最多几条会话。 */
  maxSessions?: number
  /** 请求体字节上限。 */
  maxBytes?: number
  now?: () => number
  /** 重试间隔：测试置 0，免得为一个 500 真等 800ms。 */
  retryDelayMs?: number
}

const DEFAULT_MAX_SESSIONS = 20
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 行协议：一行一个 JSON。`type` 是判别式，前端按它分派。 */
export type ServeEvent =
  | { type: 'start'; sessions: number; model: string }
  | { type: 'progress'; event: unknown }
  | { type: 'done'; run: unknown }
  | { type: 'error'; message: string; code: string }

// ---------- 工具函数 ----------

/** 只有 `file://`（Origin: null）与本机 http 页面能读到响应。 */
export function allowOrigin(origin: string | undefined): string | null {
  if (origin === undefined || origin === '') return null
  if (origin === 'null') return 'null'
  try {
    const url = new URL(origin)
    const host = url.hostname
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
      return origin
    }
  } catch {
    return null
  }
  return null
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = allowOrigin(origin)
  if (!allowed) return { vary: 'origin' }
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-tqa-token',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  extra: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extra,
  })
  response.end(body)
}

async function readBody(request: IncomingMessage, limitBytes: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limitBytes) {
      // 超限要立刻断开：继续读完等于替攻击者把内存吃掉。
      request.destroy()
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---------- 请求体 ----------

interface SessionPayload {
  id: string
  label: string
  steps: Step[]
  meta?: TrajectoryMeta
}

interface DiagnosePayload {
  sessions: SessionPayload[]
  pack?: RulePack
  task?: string
  rounds?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 逐会话重建。**不解析原文**——界面已经有归一好的轨迹，再解析一遍会重复劳动，
 *  还会因为一条 source 含多条会话而把数量搞乱。 */
function toSession(payload: SessionPayload): SessionAnalysis {
  const trajectory: Trajectory = {
    id: payload.id,
    label: payload.label,
    source: '',
    steps: payload.steps,
    meta: payload.meta ?? { totalTokens: 0, estimatedTokens: true },
    parseNotes: [],
  }
  return {
    id: payload.id,
    trajectory,
    // 立刻算一次指标：脏数据在这里就会抛出来，被逐会话 catch 住，不会污染后面。
    metrics: computeMetrics(trajectory),
    diagnostics: {
      parseMs: 0,
      metricsMs: 0,
      totalMs: 0,
      sourceChars: 0,
      stepCount: trajectory.steps.length,
    },
  }
}

function readPayload(raw: unknown, maxSessions: number): DiagnosePayload | { error: string } {
  if (!isRecord(raw)) return { error: 'body must be a JSON object' }
  const sessions = raw.sessions
  if (!Array.isArray(sessions) || sessions.length === 0) return { error: 'sessions must not be empty' }
  if (sessions.length > maxSessions) {
    return { error: 'too many sessions: max ' + maxSessions + ', got ' + sessions.length }
  }

  const parsed: SessionPayload[] = []
  for (const item of sessions) {
    if (!isRecord(item)) return { error: 'each entry in sessions must be an object' }
    const id = item.id
    const label = item.label
    const steps = item.steps
    if (typeof id !== 'string' || id === '') return { error: 'session.id is required' }
    if (typeof label !== 'string') return { error: 'session.label is required' }
    if (!Array.isArray(steps)) return { error: 'session.steps must be an array' }
    parsed.push({ id, label, steps: steps as Step[], meta: item.meta as TrajectoryMeta | undefined })
  }

  // 界面当前的规则包由前端带上：诊断必须与屏幕上显示的分数同一个口径。
  let pack: RulePack | undefined
  if (raw.pack !== undefined) {
    const validation = validatePack(raw.pack)
    if (!validation.ok) return { error: 'rule pack failed validation' }
    pack = validation.pack
  }

  return {
    sessions: parsed,
    pack,
    task: typeof raw.task === 'string' ? raw.task : undefined,
    rounds:
      typeof raw.rounds === 'number' && Number.isInteger(raw.rounds) && raw.rounds >= 2 && raw.rounds <= 40
        ? raw.rounds
        : undefined,
  }
}

// ---------- 服务 ----------

export function createAgentServer(config: ServeConfig): Server {
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const transport = config.transport ?? fetchTransport
  const locale = config.locale ?? 'zh-CN'

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // 兜底：任何未预料的异常也要给前端一条可读的回复，而不是挂断。
      if (response.headersSent) {
        response.end()
        return
      }
      sendJson(
        response,
        500,
        { error: error instanceof Error ? error.message : String(error) },
        corsHeaders(request.headers.origin),
      )
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cors = corsHeaders(request.headers.origin)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      // 不含密钥、不含端点路径：只回答「我在，且用哪个模型」。
      sendJson(
        response,
        200,
        { ok: true, model: config.llm.model, tokenRequired: config.token !== null },
        cors,
      )
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/diagnose') {
      await diagnose(request, response, cors)
      return
    }

    sendJson(response, 404, { error: 'not found' }, cors)
  }

  async function diagnose(
    request: IncomingMessage,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    // 鉴权放在读 body 之前：未授权的请求不该有机会让服务端解析几个 MB。
    if (config.token !== null) {
      const provided = request.headers['x-tqa-token']
      if (provided !== config.token) {
        sendJson(response, 401, { error: 'invalid token' }, cors)
        return
      }
    }

    const contentType = request.headers['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      sendJson(response, 415, { error: 'content-type must be application/json' }, cors)
      return
    }

    const raw = await readBody(request, maxBytes)
    if (raw === null) {
      if (!response.headersSent) sendJson(response, 413, { error: 'body too large' }, cors)
      return
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(response, 400, { error: 'body is not valid JSON' }, cors)
      return
    }

    const payload = readPayload(body, maxSessions)
    if ('error' in payload) {
      sendJson(response, 400, { error: payload.error }, cors)
      return
    }

    const sessions: SessionAnalysis[] = []
    const failures: { id: string; message: string }[] = []
    for (const item of payload.sessions) {
      try {
        sessions.push(toSession(item))
      } catch (error) {
        // 单条坏会话只丢自己：与 `analyze` 的会话级隔离同一条不变量。
        failures.push({ id: item.id, message: error instanceof Error ? error.message : String(error) })
      }
    }

    if (sessions.length === 0) {
      sendJson(response, 400, { error: 'no diagnosable session', failures }, cors)
      return
    }

    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      // 不要缓冲：进度要立刻可见。
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...cors,
    })

    const write = (event: ServeEvent): void => {
      if (response.writableEnded) return
      response.write(`${JSON.stringify(event)}\n`)
    }

    write({ type: 'start', sessions: sessions.length, model: config.llm.model })
    if (failures.length > 0) {
      write({ type: 'error', code: 'partial', message: 'some sessions could not be analyzed' })
    }

    const run = await runAgent(
      { sessions, pack: payload.pack ?? DEFAULT_PACK, annotations: [] },
      {
        transport,
        url: config.llm.url,
        model: config.llm.model,
        apiKey: config.llm.apiKey,
        locale,
        task: payload.task,
        budget: payload.rounds === undefined ? undefined : { maxRounds: payload.rounds },
        now: config.now,
        retryDelayMs: config.retryDelayMs,
        onEvent: (event) => write({ type: 'progress', event }),
      },
    )

    write({ type: 'done', run })
    response.end()
  }

  return server
}
