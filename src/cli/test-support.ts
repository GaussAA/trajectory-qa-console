/** CLI 各份测试共用的辅助：serve 的起停与请求、main 的临时目录与输出捕获。
 *  仅供测试文件导入，生产代码不得引用。 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REIMBURSEMENT_TRACE, reimbursementSessions } from '../core/test-support'
import { createAgentServer, type ServeConfig } from './serve'

/** 模型一轮就提交诊断的响应。 */
export const SUBMITTED = JSON.stringify({
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

export const LLM = { url: 'https://llm.test/v1/chat/completions', model: 'm', apiKey: 'k' }

/** 借 analyze 造一条结构正确的会话，省得手写 Step 的每个字段。 */
export function session(id = 's-1') {
  const trajectory = reimbursementSessions()[0]?.trajectory
  if (!trajectory) throw new Error('fixture failed')
  return { id, label: trajectory.label, steps: trajectory.steps, meta: trajectory.meta }
}

export async function start(overrides: Partial<ServeConfig> = {}) {
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
export function rawGet(port: number, path: string, headers: Record<string, string>) {
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

export async function diagnose(base: string, body: unknown, headers: Record<string, string> = {}) {
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

/** 发一次诊断请求，收到第一块（start 事件）就说明服务端已经开跑了：此时掐断连接。 */
export function dropAfterFirstChunk(port: number, body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
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
}

const roots: string[] = []

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tqa-main-'))
  roots.push(dir)
  return dir
}

/** 用到 tempDir 的测试文件都要挂上：`afterEach(cleanupTempDirs)`。 */
export function cleanupTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function trace(dir: string, name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

/** 一问一答的轨迹，不触发任何规则（评分 100）。 */
export const CLEAN = REIMBURSEMENT_TRACE

/** 工具调用参数被截断的轨迹（评分 54）。 */
export const BROKEN = JSON.stringify([
  { role: 'user', content: '改工单' },
  { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'update', arguments: '{"id":' } }] },
])

export function capture() {
  const chunks: { out: string; err: string } = { out: '', err: '' }
  return {
    chunks,
    io: {
      out: (chunk: string) => {
        chunks.out += chunk
      },
      err: (chunk: string) => {
        chunks.err += chunk
      },
    },
  }
}
