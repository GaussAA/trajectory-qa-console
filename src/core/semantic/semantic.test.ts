import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import type { Trajectory } from '../model'
import {
  buildDigest,
  categoryLabel,
  DEFAULT_MAX_TOKENS,
  extractContent,
  extractJson,
  inspectResponse,
  judgeTrajectory,
  parseJudgement,
  pickSteps,
  toFindings,
  type LlmRequest,
  type SemanticFinding,
} from './index'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '500 元' },
  { role: 'assistant', content: '上限 500 元。' },
])

function trajectory(): Trajectory {
  const parsed = analyze({ source: TRACE, label: 'trace.json' })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.sessions[0]!.trajectory
}

const VALID_FINDINGS = JSON.stringify({
  findings: [
    {
      category: 'unsupported_claim',
      step: 5,
      severity: 'warn',
      quote: '上限 500 元。',
      reason: '结论未引用工具返回',
    },
    { category: 'off_topic', step: 99, severity: 'error', reason: '步号越界应被丢弃' },
  ],
})

describe('prompt digest', () => {
  it('keeps every step when under the budget', () => {
    expect(pickSteps(trajectory().steps, 120)).toEqual([0, 1, 2, 3, 4])
    const digest = buildDigest(trajectory())
    expect(digest.omittedSteps).toBe(0)
    expect(digest.text).toContain('user#2: 查一下报销标准')
    expect(digest.text).toContain('tool search')
  })

  it('samples deterministically and keeps problem steps', () => {
    const base = trajectory()
    const steps = Array.from({ length: 40 }, (_, index) => ({
      ...base.steps[index % base.steps.length]!,
      index,
    }))
    const picked = pickSteps(steps, 10)
    expect(picked.length).toBeLessThanOrEqual(10)
    expect(picked).toEqual(pickSteps(steps, 10))
    // 采样结果必须严格递增，才能复现同样的提示词
    expect([...picked].sort((a, b) => a - b)).toEqual(picked)
  })

  it('marks sampling in the header', () => {
    const base = trajectory()
    const steps = Array.from({ length: 300 }, (_, index) => ({ ...base.steps[0]!, index }))
    const digest = buildDigest({ ...base, steps })
    expect(digest.includedSteps).toBeLessThanOrEqual(120)
    expect(digest.omittedSteps).toBeGreaterThan(0)
    expect(digest.text).toContain('sampled')
  })
})

describe('extractJson', () => {
  it('unwraps fenced blocks and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toBe('{"a":1}')
    expect(extractJson('[{"a":1}]')).toBe('[{"a":1}]')
    expect(extractJson('没有 JSON')).toBeNull()
  })
})

describe('parseJudgement', () => {
  it('parses findings and drops out-of-range step numbers', () => {
    const result = parseJudgement(VALID_FINDINGS, { stepCount: 5 })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value).toHaveLength(2)
    expect(result.value[0]?.step).toBe(5)
    expect(result.value[1]?.step).toBeUndefined()
  })

  it('accepts a bare array and a fenced payload', () => {
    const bare = parseJudgement('[{"category":"unsafe","severity":"error","reason":"泄露手机号"}]', {
      stepCount: 5,
    })
    if (!bare.ok) throw new Error(bare.error.message)
    expect(bare.value[0]?.category).toBe('unsafe')

    const fenced = parseJudgement('```json\n' + VALID_FINDINGS + '\n```', { stepCount: 5 })
    expect(fenced.ok).toBe(true)
  })

  it('rejects unknown categories and broken json', () => {
    const unknown = parseJudgement('{"findings":[{"category":"nonsense","reason":"x"}]}', { stepCount: 5 })
    expect(unknown.ok).toBe(false)

    const broken = parseJudgement('{"findings":[', { stepCount: 5 })
    expect(broken.ok).toBe(false)
  })

  it('caps the number of findings', () => {
    const many = {
      findings: Array.from({ length: 30 }, () => ({
        category: 'off_topic',
        severity: 'info',
        reason: 'x',
      })),
    }
    const result = parseJudgement(JSON.stringify(many), { stepCount: 5, maxFindings: 4 })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value).toHaveLength(4)
  })
})

describe('extractContent', () => {
  it('reads the OpenAI shape, content parts and plain text proxies', () => {
    expect(extractContent(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))).toBe('hi')
    expect(
      extractContent(JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })),
    ).toBe('ab')
    expect(extractContent(JSON.stringify({ output_text: 'plain' }))).toBe('plain')
    expect(extractContent('不是 JSON 的一段话')).toBe('不是 JSON 的一段话')
    expect(extractContent('')).toBeNull()
  })

  it('reads the response shape for failure diagnosis', () => {
    expect(
      inspectResponse(
        JSON.stringify({ choices: [{ message: { content: 'ok', reasoning: '想一想' }, finish_reason: 'stop' }] }),
      ),
    ).toEqual({ content: 'ok', finishReason: 'stop', reasoningChars: 3 })

    // 非 JSON：finish_reason 无从谈起，但内容仍按代理直返文本处理。
    expect(inspectResponse('裸文本')).toEqual({ content: '裸文本', finishReason: null, reasoningChars: 0 })
  })
})

describe('judgeTrajectory', () => {
  const baseOptions = {
    url: 'https://llm.example/v1/chat/completions',
    model: 'test-model',
    apiKey: 'secret-key',
    retryDelayMs: 0,
    digest: { maxSteps: 50, textChars: 200, resultChars: 100 },
  }

  it('returns parsed findings on success', async () => {
    const calls: LlmRequest[] = []
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      transport: async (request) => {
        calls.push(request)
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: VALID_FINDINGS } }] }),
        }
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.apiKey).toBe('secret-key')
    expect(JSON.parse(calls[0]!.body).messages).toHaveLength(2)
  })

  it('retries once on 429 and then succeeds', async () => {
    let attempts = 0
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      transport: async () => {
        attempts += 1
        if (attempts === 1) return { ok: false, status: 429, text: 'rate limited' }
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })
    expect(attempts).toBe(2)
    expect(result.ok).toBe(true)
  })

  it('does not retry a 400 and keeps the key out of the error', async () => {
    let attempts = 0
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      transport: async () => {
        attempts += 1
        return { ok: false, status: 400, text: 'bad request' }
      },
    })
    expect(attempts).toBe(1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('400')
    expect(JSON.stringify(result.error)).not.toContain('secret-key')
  })

  it('gives up on timeout', async () => {
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      retries: 0,
      timeoutMs: 10,
      transport: () => new Promise(() => undefined),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('超时')
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      signal: controller.signal,
      transport: () => new Promise(() => undefined),
    })
    expect(result.ok).toBe(false)
  })

  it('sends an explicit max_tokens (reasoning models eat the budget first)', async () => {
    const bodies: string[] = []
    await judgeTrajectory(trajectory(), {
      ...baseOptions,
      transport: async (request) => {
        bodies.push(request.body)
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })
    expect(JSON.parse(bodies[0]!).max_tokens).toBe(DEFAULT_MAX_TOKENS)

    await judgeTrajectory(trajectory(), {
      ...baseOptions,
      maxTokens: 512,
      transport: async (request) => {
        bodies.push(request.body)
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })
    expect(JSON.parse(bodies[1]!).max_tokens).toBe(512)
  })

  it('blames the token budget when thinking swallowed the whole response', async () => {
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      maxTokens: 128,
      transport: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { content: '', reasoning: '思考'.repeat(40) }, finish_reason: 'length' }],
        }),
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 「被截断」与「模型什么都没说」必须能分辨：前者只需调大预算。
    expect(result.error.message).toContain('截断')
    expect(result.error.detail?.finishReason).toBe('length')
    expect(result.error.detail?.reasoningChars).toBe(80)
  })

  it('reports a plain empty response without blaming the budget', async () => {
    const result = await judgeTrajectory(trajectory(), {
      ...baseOptions,
      transport: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('模型响应里没有可用内容')
  })
})

describe('toFindings', () => {
  const items: SemanticFinding[] = [
    { category: 'off_topic', step: 3, severity: 'warn', quote: '原文', reason: '没有回应用户' },
  ]

  it('maps to scoring findings with a localized title', () => {
    const [finding] = toFindings(items, 'zh-CN', 'trace-1')
    expect(finding?.ruleId).toBe('semantic.llm.off_topic')
    expect(finding?.dimension).toBe('semantic')
    expect(finding?.ruleTitle).toBe('答非所问')
    expect(finding?.stepIndex).toBe(2)
    expect(finding?.impact).toBe(6)
    expect(finding?.evidence).toBe('原文')
  })

  it('localizes the title for English', () => {
    expect(categoryLabel('en', 'overreach')).toBe('Overreach')
    expect(toFindings(items, 'en', 'trace-1')[0]?.ruleTitle).toBe('Off-topic answer')
  })
})
