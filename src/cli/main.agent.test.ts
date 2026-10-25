/** CLI 的智能体诊断（--agent）：配置与互斥、dry-run、产物落盘、写盘失败与端点失败时的退出码。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, loadPack, main } from './main'
import { CLEAN, capture, cleanupTempDirs, tempDir, trace } from './test-support'

afterEach(cleanupTempDirs)

describe('agent diagnosis', () => {
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
                arguments: JSON.stringify({
                  verdict: '整体可用，短板在错误恢复。',
                  rootCauses: [{ cause: '工具报错后放弃', evidence: '第 2 步' }],
                  actions: [{ action: '提高扣分', ruleId: 'exec-tool-error' }],
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  })

  const PROPOSED = JSON.stringify({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c0',
              type: 'function',
              function: {
                name: 'propose_pack',
                arguments: JSON.stringify({
                  rationale: '执行维扣分偏轻',
                  edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 30 }],
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  })

  /** 按序回放若干回合：CLI 测试只关心「接得上」，不需要完整循环行为。 */
  function sequence(replies: string[]) {
    let index = 0
    return async () => {
      const text = replies[Math.min(index, replies.length - 1)] ?? ''
      index += 1
      return { ok: true, status: 200, text }
    }
  }

  const LLM_ENV = { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' }

  it('refuses to run without configuration', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--agent'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('诊断缺少配置')
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('refuses to combine with --semantic', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()
    let calls = 0

    const code = await main([dir, '--agent', '--semantic'], io, {
      env: LLM_ENV,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('--semantic')
    // 冲突要在烧配额之前被发现
    expect(calls).toBe(0)
  })

  it('refuses to combine with --compare', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', CLEAN)
    const { io } = capture()

    expect(await main([dir, '--agent', '--compare'], io, { env: LLM_ENV })).toBe(EXIT.error)
  })

  it('prints the prompt and tool list on a dry run, calling nothing', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()
    let calls = 0

    const code = await main([dir, '--agent-dry-run'], io, {
      env: {},
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.ok)
    expect(calls).toBe(0)
    expect(chunks.out).toContain('submit_diagnosis')
    expect(chunks.out).toContain('数字只能来自工具')
  })

  it('puts --agent-task into the prompt so the model can be pointed at one question', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main([dir, '--agent-dry-run', '--agent-task', '只看工具报错后有没有重试'], io, {
      env: {},
    })

    expect(code).toBe(EXIT.ok)
    expect(chunks.out).toContain('只看工具报错后有没有重试')
  })

  it('writes agent.md and agent.json next to the report', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    expect(code).toBe(EXIT.ok)
    const markdown = readFileSync(join(out, 'agent.md'), 'utf8')
    const json = JSON.parse(readFileSync(join(out, 'agent.json'), 'utf8')) as { stopReason: string }
    expect(markdown).toContain('轨迹诊断报告')
    expect(markdown).toContain('整体可用')
    expect(json.stopReason).toBe('submitted')
    // 隐私提示走 stderr，且不被 --quiet 吞掉
    expect(chunks.err).toContain('llm.test')
    expect(chunks.out).toContain('1 次工具调用')
  })

  it('saves the trace to the requested path', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const tracePath = join(dir, 'trace.json')
    const { io } = capture()

    const code = await main([dir, '--agent', '--agent-trace', tracePath, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    expect(code).toBe(EXIT.ok)
    expect(existsSync(tracePath)).toBe(true)
  })

  it('writes a candidate pack that --pack can load as-is', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: sequence([PROPOSED, SUBMITTED]),
    })

    expect(code).toBe(EXIT.ok)
    const packPath = join(out, 'proposal.pack.json')
    expect(existsSync(packPath)).toBe(true)

    // 端到端的关键一条：静态检查不等于「能当 --pack 用」，真的加载一遍。
    const loaded = loadPack(packPath)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.pack.name).toContain('提案 1')
    expect(loaded.pack.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).toBe(30)

    const markdown = readFileSync(join(out, 'agent.md'), 'utf8')
    expect(markdown).toContain('规则包提案')
    expect(chunks.out).toContain('proposal.pack.json')
  })

  it('says how to save proposals when there is no --out', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--quiet'], io, {
      env: LLM_ENV,
      transport: sequence([PROPOSED, SUBMITTED]),
    })

    expect(code).toBe(EXIT.ok)
    expect(chunks.err).toContain('--out')
    expect(chunks.err).toContain('规则包提案')
  })

  it('does not throw when --out is unwritable, and still prints the diagnosis it paid for', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    // 普通报告（report.*）先写、能写成功；只有 agent.md 是个目录，写它必然失败。
    // （--out 整个不可写时，普通报告分支先失败并直接返回，智能体根本不会跑，也就没花钱。）
    mkdirSync(join(out, 'agent.md'), { recursive: true })
    const { io, chunks } = capture()

    const code = await main([join(dir, 'clean.json'), '--agent', '--out', out], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    // 之前这里会让 main() 带着一份栈 reject；现在是退出码 2 加一条写盘错误
    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
    // 诊断已经花了钱：结论不能因为 agent.md 写不进去就丢掉
    expect(chunks.out).toContain('# 轨迹诊断报告')
  })

  it('never starts the paid diagnosis when --out cannot be written at all', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const { io } = capture()
    let calls = 0

    const code = await main([join(dir, 'clean.json'), '--agent', '--out', join(blocker, 'sub')], io, {
      env: LLM_ENV,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(calls).toBe(0)
  })

  it('exits 2 when the endpoint fails, after still writing the report', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: false, status: 500, text: 'boom' }),
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('诊断失败')
    // 失败也得留下证据：报告照写。
    expect(existsSync(join(out, 'agent.md'))).toBe(true)
  })
})
