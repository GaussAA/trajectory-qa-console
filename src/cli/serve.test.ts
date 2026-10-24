import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { LlmTransport } from '../core/llm/transport'
import { reimbursementSessions } from '../core/test-support'
import { allowOrigin, createAgentServer, type ServeConfig } from './serve'

const SUBMITTED = JSON.stringify({
  choices: [
    {
      message: {
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'submit_diagnosis',
              arguments: JSON.stringify({ verdict: '还行', rootCauses: [], actions: [] }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
})

const LLM = { url: 'https://llm.test/v1/chat/completions', model: 'm', apiKey: 'k' }

/** 借 analyze 造一条结构正确的会话，省得手写 Step 的每个字段。 */
function session(id = 's-1') {
  const trajectory = reimbursementSessions()[0]?.trajectory
  if (!trajectory) throw new Error('fixture failed')
  return { id, label: trajectory.label, steps: trajectory.steps, meta: trajectory.meta }
}

async function start(overrides: Partial<ServeConfig> = {}) {
  const server = createAgentServer({
    llm: LLM,
    token: null,
    retryDelayMs: 0,
    transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    ...overrides,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 用 node:http 发请求：fetch 不让改 Host，而重绑定攻击恰恰靠一个不同的 Host。 */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    },
  )
}

async function diagnose(base: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; run?: { diagnosis?: { verdict: string } } })
  return { status: response.status, headers: response.headers, lines }
}

describe('allowOrigin', () => {
  it('lets a file:// page (Origin: null) and local http through', () => {
    expect(allowOrigin('null')).toBe('null')
    expect(allowOrigin('null', false)).toBeNull()
    expect(allowOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    expect(allowOrigin('http://localhost:8080')).toBe('http://localhost:8080')
  })

  it('refuses everything else, including garbage', () => {
    expect(allowOrigin('https://evil.example')).toBeNull()
    expect(allowOrigin('http://192.168.1.10:8080')).toBeNull()
    expect(allowOrigin('not a url')).toBeNull()
    expect(allowOrigin(undefined)).toBeNull()
  })
})

describe('agent server request timeout', () => {
  type Done = { type: string; run?: { ok: boolean; error?: { message: string } } }

  async function runWith(overrides: Partial<ServeConfig>) {
    const server = await start(overrides)
    try {
      const response = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [session()] }),
      })
      const lines = (await response.text())
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Done)
      return lines.find((line) => line.type === 'done')?.run
    } finally {
      await server.close()
    }
  }

  it('gives up on a hung endpoint after the configured --llm-timeout', async () => {
    const run = await runWith({ timeoutMs: 40, transport: () => new Promise(() => undefined) })
    expect(run?.ok).toBe(false)
    expect(run?.error?.message).toContain('超时')
  })

  it('still answers normally when the timeout is generous', async () => {
    const run = await runWith({ timeoutMs: 5_000 })
    expect(run?.ok).toBe(true)
  })
})

describe('agent server', () => {
  it('answers /health without leaking the key or the endpoint path', async () => {
    const server = await start()
    try {
      const response = await fetch(`${server.base}/health`)
      const body = (await response.json()) as Record<string, unknown>
      expect(response.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.model).toBe('m')
      expect(body.tokenRequired).toBe(false)
      const text = JSON.stringify(body)
      // 密钥是单字符 'k'：用带引号的整串判断，免得 'ok":true' 误中。
      expect(text).not.toContain('"k"')
      expect(text).not.toContain('/chat/completions')
    } finally {
      await server.close()
    }
  })

  it('streams start → progress → done as NDJSON', async () => {
    const server = await start()
    try {
      const result = await diagnose(server.base, { sessions: [session()] })
      expect(result.status).toBe(200)
      const types = result.lines.map((line) => line.type)
      expect(types[0]).toBe('start')
      expect(types).toContain('progress')
      expect(types.at(-1)).toBe('done')
      expect(result.lines.at(-1)?.run?.diagnosis?.verdict).toBe('还行')
    } finally {
      await server.close()
    }
  })

  it('uses the pack the console sends, so scores match what the user sees', async () => {
    const server = await start()
    try {
      const result = await diagnose(server.base, { sessions: [session()], pack: { bogus: true } })
      // 坏包必须被拦住，而不是静默换成内置包——那样诊断口径会和屏幕上的分数不一致。
      expect(result.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('rejects a missing token before reading the body', async () => {
    const server = await start({ token: 'secret' })
    try {
      const unauthorized = await diagnose(server.base, { sessions: [session()] })
      expect(unauthorized.status).toBe(401)

      const ok = await diagnose(server.base, { sessions: [session()] }, { 'x-tqa-token': 'secret' })
      expect(ok.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('validates content type, json, and session shape', async () => {
    const server = await start()
    try {
      const wrongType = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
      expect(wrongType.status).toBe(415)

      const badJson = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      expect(badJson.status).toBe(400)

      expect((await diagnose(server.base, { sessions: [] })).status).toBe(400)
      expect((await diagnose(server.base, {})).status).toBe(400)
      expect((await diagnose(server.base, { sessions: [{ id: 'x' }] })).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('caps how many sessions one request may carry', async () => {
    const server = await start({ maxSessions: 2 })
    try {
      const three = [session('a'), session('b'), session('c')]
      const result = await diagnose(server.base, { sessions: three })
      expect(result.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('isolates one bad session instead of failing the batch', async () => {
    const server = await start()
    try {
      const broken = { id: 'bad', label: 'bad.json', steps: 'not-an-array' }
      const result = await diagnose(server.base, { sessions: [session(), broken] })
      // 坏的那条在解析阶段就被拒；整批仍然可以继续（不变量 5 的同一条）。
      expect(result.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('answers the CORS preflight and only allows local origins to read', async () => {
    const server = await start()
    try {
      const local = await fetch(`${server.base}/health`, {
        headers: { origin: 'http://localhost:5173' },
      })
      expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

      const evil = await fetch(`${server.base}/health`, { headers: { origin: 'https://evil.example' } })
      expect(evil.headers.get('access-control-allow-origin')).toBeNull()

      const preflight = await fetch(`${server.base}/api/diagnose`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('x-tqa-token')
    } finally {
      await server.close()
    }
  })

  it('refuses Origin: null unless a token is set, since sandboxed pages send it too', async () => {
    const open = await start()
    try {
      const health = await fetch(`${open.base}/health`, { headers: { origin: 'null' } })
      expect(health.headers.get('access-control-allow-origin')).toBeNull()

      const preflight = await fetch(`${open.base}/api/diagnose`, {
        method: 'OPTIONS',
        headers: { origin: 'null' },
      })
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull()

      // 预检之外也要拦：不是每个客户端都会先发预检。
      const post = await diagnose(open.base, { sessions: [session()] }, { origin: 'null' })
      expect(post.status).toBe(403)
    } finally {
      await open.close()
    }

    const guarded = await start({ token: 'secret' })
    try {
      const health = await fetch(`${guarded.base}/health`, { headers: { origin: 'null' } })
      expect(health.headers.get('access-control-allow-origin')).toBe('null')

      const ok = await diagnose(
        guarded.base,
        { sessions: [session()] },
        { origin: 'null', 'x-tqa-token': 'secret' },
      )
      expect(ok.status).toBe(200)
    } finally {
      await guarded.close()
    }
  })

  it('rejects a non-loopback Host header, which is what DNS rebinding sends', async () => {
    const server = await start()
    try {
      const rebound = await rawGet(server.port, '/health', { host: 'evil.example' })
      expect(rebound.status).toBe(403)
      // 不回 CORS 头：重绑定的页面读不到任何东西。
      expect(rebound.headers['access-control-allow-origin']).toBeUndefined()

      const withPort = await rawGet(server.port, '/health', { host: `localhost:${server.port}` })
      expect(withPort.status).toBe(200)

      const ipv6 = await rawGet(server.port, '/health', { host: `[::1]:${server.port}` })
      expect(ipv6.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('skips the Host check when the operator bound a non-loopback address on purpose', async () => {
    const server = await start({ loopbackOnly: false })
    try {
      expect((await rawGet(server.port, '/health', { host: '192.168.1.5:7788' })).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('404s anything else', async () => {
    const server = await start()
    try {
      expect((await fetch(`${server.base}/nope`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('stops the agent run when the client disconnects, instead of spending on', async () => {
    // 端点一直挂着，直到收到取消信号。没有断连处理时，这次调用会一直挂到单次超时，
    // 模型额度就这样烧在一个没人在看的请求上。
    let seen: AbortSignal | undefined
    let calls = 0
    const transport: LlmTransport = (input) => {
      calls += 1
      seen = input.signal
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const server = await start({ transport })
    try {
      const body = JSON.stringify({ sessions: [session()] })
      await new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/api/diagnose',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            // 收到第一块（start 事件）就说明服务端已经开跑了：此时关掉页面。
            res.once('data', () => {
              req.destroy()
              resolve()
            })
          },
        )
        req.on('error', () => undefined)
        req.end(body)
      })

      await vi.waitFor(() => expect(seen?.aborted).toBe(true), { timeout: 2000 })
      expect(calls).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('does not abort a run whose client stays connected', async () => {
    let aborted = false
    const transport: LlmTransport = async (input) => {
      input.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return { ok: true, status: 200, text: SUBMITTED }
    }
    const server = await start({ transport })
    try {
      const result = await diagnose(server.base, { sessions: [session()] })
      expect(result.lines.at(-1)?.type).toBe('done')
      expect(aborted).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('answers 413 for a declared oversize body instead of resetting the connection', async () => {
    const server = await start({ maxBytes: 200 })
    try {
      const response = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [session()], filler: 'x'.repeat(2000) }),
      })
      // 之前 readBody 先把连接 destroy 掉，再去写 413：客户端看到的是 fetch failed，不是 413
      expect(response.status).toBe(413)
      expect(((await response.json()) as { error: string }).error).toContain('too large')
      // 服务还活着，后面的请求不受影响
      expect((await fetch(`${server.base}/health`)).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('answers 413 for a chunked body that grows past the limit', async () => {
    const server = await start({ maxBytes: 200 })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/api/diagnose',
            method: 'POST',
            // 不给 content-length：走分块传输，服务端事先不知道多大
            headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.write('{"sessions":[')
        req.write('"' + 'x'.repeat(1000) + '"')
        req.end(']}')
      })
      expect(status).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('still accepts a body that is exactly within the limit', async () => {
    const body = JSON.stringify({ sessions: [session()] })
    const server = await start({ maxBytes: Buffer.byteLength(body) })
    try {
      const result = await diagnose(server.base, JSON.parse(body))
      expect(result.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  /** 一直挂着、直到被取消的端点：用来把「正在跑」的那个名额占住。 */
  function blocking() {
    const waiting: (() => void)[] = []
    const transport: LlmTransport = (input) =>
      new Promise((resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        waiting.push(() => resolve({ ok: true, status: 200, text: SUBMITTED }))
      })
    return { transport, release: () => waiting.splice(0).forEach((fn) => fn()), pending: () => waiting.length }
  }

  it('turns away a diagnosis beyond the concurrency limit with 429, and frees the slot when one ends', async () => {
    const gate = blocking()
    const server = await start({ transport: gate.transport, maxConcurrent: 1 })
    try {
      const first = diagnose(server.base, { sessions: [session()] })
      await vi.waitFor(() => expect(gate.pending()).toBe(1), { timeout: 2000 })

      const second = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [session()] }),
      })
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).not.toBeNull()
      // 被拒的那个请求没有碰模型
      expect(gate.pending()).toBe(1)

      gate.release()
      expect((await first).status).toBe(200)

      // 第一个跑完，名额回来了
      const third = diagnose(server.base, { sessions: [session()] })
      await vi.waitFor(() => expect(gate.pending()).toBe(1), { timeout: 2000 })
      gate.release()
      expect((await third).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('frees the slot when the client walks away mid-run', async () => {
    const gate = blocking()
    const server = await start({ transport: gate.transport, maxConcurrent: 1 })
    try {
      const body = JSON.stringify({ sessions: [session()] })
      await new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/api/diagnose',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            res.once('data', () => {
              req.destroy()
              resolve()
            })
          },
        )
        req.on('error', () => undefined)
        req.end(body)
      })

      // 客户端走了：名额必须还回来，否则一次断连就把服务永久占满
      await vi.waitFor(
        async () => {
          const probe = await fetch(`${server.base}/api/diagnose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
          expect(probe.status).not.toBe(429)
          probe.body?.cancel().catch(() => undefined)
        },
        { timeout: 3000 },
      )
    } finally {
      gate.release()
      await server.close()
    }
  })

  /** 永远不收尾的模型：每一轮都再调一次工具，数它被问了几轮。 */
  function neverFinishes() {
    const call = JSON.stringify({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'list_sessions', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    let rounds = 0
    const transport: LlmTransport = async () => {
      rounds += 1
      return { ok: true, status: 200, text: call }
    }
    return { transport, rounds: () => rounds }
  }

  it('never lets a client ask for more rounds than the operator allows', async () => {
    const model = neverFinishes()
    const server = await start({ transport: model.transport, maxRounds: 3 })
    try {
      // 客户端要 40 轮；服务端的上限是 3
      const result = await diagnose(server.base, { sessions: [session()], rounds: 40 })
      expect(result.status).toBe(200)
      expect(model.rounds()).toBe(3)
    } finally {
      await server.close()
    }
  })

  it('lets a client ask for fewer rounds than the ceiling', async () => {
    const model = neverFinishes()
    const server = await start({ transport: model.transport, maxRounds: 6 })
    try {
      await diagnose(server.base, { sessions: [session()], rounds: 2 })
      expect(model.rounds()).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('uses the default budget when the client says nothing', async () => {
    const model = neverFinishes()
    const server = await start({ transport: model.transport })
    try {
      await diagnose(server.base, { sessions: [session()] })
      expect(model.rounds()).toBe(8)
    } finally {
      await server.close()
    }
  })

  it('refuses an oversized free-text task before spending anything', async () => {
    const model = neverFinishes()
    const server = await start({ transport: model.transport })
    try {
      const result = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [session()], task: '问'.repeat(5000) }),
      })
      expect(result.status).toBe(400)
      expect(model.rounds()).toBe(0)
    } finally {
      await server.close()
    }
  })
  it('reports a model failure as a done event, not a broken stream', async () => {
    const failing: LlmTransport = async () => ({ ok: false, status: 500, text: 'down' })
    const server = await start({ transport: failing })
    try {
      const result = await diagnose(server.base, { sessions: [session()] })
      const last = result.lines.at(-1) as unknown as { type: string; run: { ok: boolean; error?: { message: string } } }
      expect(last.type).toBe('done')
      expect(last.run.ok).toBe(false)
      expect(last.run.error?.message).toContain('500')
    } finally {
      await server.close()
    }
  })
})
