/** CLI 的语义复核（--semantic）：配置、合并进评分、失败降级、dry-run 与上限；
 *  以及「校验先于花钱」——参数有错时不能先把额度烧掉。 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, chatCompletionsUrl, main } from './main'
import { CLEAN, capture, cleanupTempDirs, tempDir, trace } from './test-support'

afterEach(cleanupTempDirs)

describe('validation happens before anything that costs money', () => {
  const ENV = { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' }

  it('rejects a bad --pack-compare file before making a single --semantic call', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    let calls = 0
    const { io, chunks } = capture()

    const code = await main([dir, '--semantic', '--pack-compare', join(dir, 'nope.pack.json')], io, {
      env: ENV,
      transport: async () => {
        calls += 1
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('规则包')
    // 之前是先把额度烧完，再告诉你规则包路径写错了
    expect(calls).toBe(0)
  })
})

describe('semantic review', () => {
  it('completes a versioned base url but leaves custom proxy paths alone', () => {
    expect(chatCompletionsUrl('https://token.sensenova.cn/v1')).toBe(
      'https://token.sensenova.cn/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://token.sensenova.cn/v1/')).toBe(
      'https://token.sensenova.cn/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://host/v1/chat/completions')).toBe('https://host/v1/chat/completions')
    // 本地代理自带路径：拼一层就成了 .../api/chat/chat/completions，等于把能用的配置改坏。
    expect(chatCompletionsUrl('http://127.0.0.1:18880/api/chat')).toBe('http://127.0.0.1:18880/api/chat')
    expect(chatCompletionsUrl('   ')).toBe('')
  })

  it('takes the base url from TQA_LLM_BASE_URL when no full url is given', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const urls: string[] = []
    const { io } = capture()

    await main([dir, '--semantic', '--quiet'], io, {
      env: {
        TQA_LLM_BASE_URL: 'https://token.sensenova.cn/v1',
        TQA_LLM_MODEL: 'm',
        TQA_LLM_API_KEY: 'k',
      },
      transport: async (request) => {
        urls.push(request.url)
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })

    expect(urls).toEqual(['https://token.sensenova.cn/v1/chat/completions'])
  })

  const JUDGEMENT = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            findings: [
              { category: 'unsafe', step: 2, severity: 'error', quote: '原文', reason: '泄露了手机号' },
            ],
          }),
        },
      },
    ],
  })

  it('refuses to run without configuration', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--semantic'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('语义复核缺少配置')
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('merges model findings into the score and reports them', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const calls: { apiKey: string }[] = []
    const { io, chunks } = capture()

    const code = await main(
      [dir, '--semantic', '--llm-url', 'https://llm.example/v1', '--llm-model', 'm', '--out', out, '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k-123' },
        transport: async (request) => {
          calls.push({ apiKey: request.apiKey })
          return { ok: true, status: 200, text: JUDGEMENT }
        },
      },
    )

    expect(code).toBe(EXIT.ok)
    expect(calls).toHaveLength(1)
    expect(chunks.out).toContain('语义复核：1 个会话，1 条判定')
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('安全或合规风险')
    expect(report).toContain('泄露了手机号')
  })

  it('degrades to rule findings when the model call fails', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main(
      [dir, '--semantic', '--llm-url', 'https://llm.example/v1', '--llm-model', 'm', '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k' },
        transport: async () => ({ ok: false, status: 400, text: 'bad request' }),
      },
    )

    // 语义失败不改变退出码：规则结论照旧可用。
    expect(code).toBe(EXIT.ok)
    expect(chunks.out).toContain('语义复核失败 1 次')
  })

  it('prints the prompt on --semantic-dry-run and never calls the model', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    let called = 0
    const { io, chunks } = capture()

    const code = await main([dir, '--semantic-dry-run'], io, {
      env: {},
      transport: async () => {
        called += 1
        return { ok: true, status: 200, text: '{}' }
      },
    })

    expect(code).toBe(EXIT.ok)
    expect(called).toBe(0)
    const prompt = JSON.parse(chunks.out) as { role: string; content: string }[]
    expect(prompt[0]?.content).toContain('只输出 JSON')
    expect(prompt[1]?.content).toContain('查一下报销标准')
  })

  it('honours --semantic-limit', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', CLEAN)
    let called = 0
    const { io, chunks } = capture()

    await main(
      [dir, '--semantic', '--llm-url', 'u', '--llm-model', 'm', '--semantic-limit', '1', '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k' },
        transport: async () => {
          called += 1
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
          }
        },
      },
    )

    expect(called).toBe(1)
    expect(chunks.out).toContain('语义复核：1 个会话')
    expect(chunks.err).toContain('--semantic-limit')
  })
})
