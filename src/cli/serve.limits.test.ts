/** serve 的各类上限：单次请求超时、请求体大小、轮数预算、自由文本任务长度。 */

import { request as httpRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { LlmTransport } from '../core/llm/transport'
import type { ServeConfig } from './serve'
import { diagnose, session, start } from './test-support'

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

describe('agent server body size limit', () => {
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
})

describe('agent server round budget', () => {
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
})
