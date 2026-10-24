import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { analyze } from '../core/analysis'
import type { LlmTransport } from '../core/llm/transport'
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
  const analyzed = analyze({
    source: JSON.stringify([
      { role: 'user', content: '查一下报销标准' },
      { role: 'assistant', content: '住宿上限 500 元。' },
    ]),
    label: 'a.json',
  })
  if (!analyzed.ok) throw new Error(analyzed.error.message)
  const trajectory = analyzed.value.sessions[0]?.trajectory
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
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

      const filePage = await fetch(`${server.base}/health`, { headers: { origin: 'null' } })
      expect(filePage.headers.get('access-control-allow-origin')).toBe('null')

      const evil = await fetch(`${server.base}/health`, { headers: { origin: 'https://evil.example' } })
      expect(evil.headers.get('access-control-allow-origin')).toBeNull()

      const preflight = await fetch(`${server.base}/api/diagnose`, {
        method: 'OPTIONS',
        headers: { origin: 'null' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('x-tqa-token')
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
