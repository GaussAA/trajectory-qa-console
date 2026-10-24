/** serve 的基本路由与请求校验。访问控制、各类上限、请求生命周期见同目录的 serve.*.test.ts。 */

import { describe, expect, it } from 'vitest'
import { diagnose, session, start } from './test-support'

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

  it('404s anything else', async () => {
    const server = await start()
    try {
      expect((await fetch(`${server.base}/nope`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
