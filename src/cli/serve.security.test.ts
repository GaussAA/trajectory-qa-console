/** serve 的访问控制：token、CORS、Origin: null 与 DNS 重绑定（Host 头）。 */

import { describe, expect, it } from 'vitest'
import { allowOrigin } from './serve'
import { diagnose, rawGet, session, start } from './test-support'

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

describe('agent server access control', () => {
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
})
