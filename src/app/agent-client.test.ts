import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyze } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { diagnose, readAgentTarget } from './agent-client'

const SUBMITTED = {
  ok: true,
  diagnosis: { verdict: '还行', rootCauses: [], actions: [] },
  answer: '还行',
  proposals: [],
  trace: { entries: [], rounds: 1, toolCalls: 1, truncated: false, stopReason: 'submitted' },
  usage: { prompt: 10, completion: 5 },
}

function sessions() {
  const parsed = analyze({
    source: JSON.stringify([
      { role: 'user', content: '查一下报销标准' },
      { role: 'assistant', content: '住宿上限 500 元。' },
    ]),
    label: 'a.json',
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.sessions
}

function streamOf(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** 只关心「发了什么、回了什么」，不关心真实网络。 */
function stubFetch(handler: (init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(init)
  })
  vi.stubGlobal('fetch', spy)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readAgentTarget', () => {
  it('reads the endpoint and the optional token', () => {
    expect(readAgentTarget('?agent=http://127.0.0.1:7788')).toEqual({
      endpoint: 'http://127.0.0.1:7788',
      token: null,
    })
    expect(readAgentTarget('?agent=http://127.0.0.1:7788/&agentToken=abc')).toEqual({
      endpoint: 'http://127.0.0.1:7788',
      token: 'abc',
    })
  })

  it('returns null when the console was opened without ?agent', () => {
    expect(readAgentTarget('')).toBeNull()
    expect(readAgentTarget('?compare#demo')).toBeNull()
    expect(readAgentTarget('?agent=')).toBeNull()
  })
})

describe('diagnose', () => {
  const base = { target: { endpoint: 'http://127.0.0.1:7788', token: null }, pack: DEFAULT_PACK }

  it('sends sessions without their raw payloads', async () => {
    const calls = stubFetch(() => streamOf([{ type: 'start', sessions: 1 }, { type: 'done', run: SUBMITTED }]))

    const result = await diagnose({ ...base, sessions: sessions() })

    expect(result.ok).toBe(true)
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      sessions: { steps: Record<string, unknown>[] }[]
    }
    expect(body.sessions[0]?.steps.length).toBeGreaterThan(0)
    // raw 是解析前的原始对象，常常比整条轨迹还大，不该发出去。
    expect(body.sessions[0]?.steps.every((step) => !('raw' in step))).toBe(true)
  })

  it('forwards progress events and returns the finished run', async () => {
    stubFetch(() =>
      streamOf([
        { type: 'start', sessions: 1, model: 'sensenova-test' },
        { type: 'progress', event: { kind: 'round', round: 1, toolCalls: 1 } },
        { type: 'progress', event: { kind: 'tool', round: 1, name: 'list_sessions', ok: true, ms: 3 } },
        { type: 'done', run: SUBMITTED },
      ]),
    )

    const seen: string[] = []
    const result = await diagnose({
      ...base,
      sessions: sessions(),
      onEvent: (event) => seen.push(event.kind),
    })

    expect(seen).toEqual(['round', 'tool'])
    expect(result.ok && result.run.diagnosis?.verdict).toBe('还行')
    // 报告头部要写清真用了哪个模型，所以这条信息得从 start 事件带出来。
    expect(result.ok && result.model).toBe('sensenova-test')
  })

  it('reports a stopped service as offline rather than a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    const result = await diagnose({ ...base, sessions: sessions() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 界面要靠这个码区分「没起服务」与「服务报错」，两者的下一步动作完全不同。
    expect(result.code).toBe('offline')
  })

  it('surfaces the server message on a 4xx', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 }))

    const result = await diagnose({ ...base, sessions: sessions() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('http')
    expect(result.message).toContain('invalid token')
  })

  it('treats a partial-run notice as a warning, not a failure', async () => {
    stubFetch(() =>
      streamOf([
        { type: 'start', sessions: 1 },
        { type: 'error', code: 'partial', message: '1 条会话无法诊断' },
        { type: 'done', run: SUBMITTED },
      ]),
    )

    const result = await diagnose({ ...base, sessions: sessions() })
    expect(result.ok).toBe(true)
    expect(result.ok && result.partial).toContain('无法诊断')
  })

  it('fails when the stream ends without a run', async () => {
    stubFetch(() => streamOf([{ type: 'start', sessions: 1 }]))

    const result = await diagnose({ ...base, sessions: sessions() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('stream')
  })

  it('skips malformed stream lines instead of dying', async () => {
    const body = `{"type":"start"}\n{not json\n${JSON.stringify({ type: 'done', run: SUBMITTED })}\n`
    stubFetch(() => new Response(body, { status: 200 }))

    const result = await diagnose({ ...base, sessions: sessions() })
    expect(result.ok).toBe(true)
  })
})
