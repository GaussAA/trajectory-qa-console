import { describe, expect, it } from 'vitest'
import { analyze } from '../core/analysis'
import type { AgentRun, PackProposal } from '../core/agent/types'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import {
  buildAgentReportModel,
  endpointHost,
  renderAgentJson,
  renderAgentMarkdown,
  type AgentReportInput,
} from './agent-report'

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    ok: true,
    diagnosis: {
      verdict: '整体可用，短板在错误恢复。',
      rootCauses: [{ session: 's-1', cause: '工具报错后直接放弃', evidence: '第 4 步' }],
      actions: [{ action: '提高扣分', rationale: '试跑后均值下降', ruleId: 'exec-tool-error' }],
    },
    answer: '整体可用，短板在错误恢复。',
    proposals: [],
    trace: {
      entries: [
        { kind: 'model', round: 1, content: '', toolCalls: 1, reasoningChars: 12, ms: 300 },
        {
          kind: 'tool',
          round: 1,
          name: 'list_sessions',
          args: '{}',
          ok: true,
          result: '{"sessions":[]}',
          ms: 5,
        },
      ],
      rounds: 1,
      toolCalls: 1,
      truncated: false,
      stopReason: 'submitted',
    },
    usage: { prompt: 10, completion: 5 },
    ...overrides,
  }
}

const PROPOSAL: PackProposal = {
  id: 'p1',
  rationale: '执行维扣分偏轻：死循环只降 25 分',
  edits: [{ ruleId: 'exec-dead-loop', severity: 'error', scoreImpact: 30 }],
  applied: [{ ruleId: 'exec-dead-loop', severity: 'error', scoreImpact: 30, effectiveImpact: 30 }],
  pack: { ...DEFAULT_PACK, name: '内置规则包 · v1 · 提案 1' },
  averageBefore: 76,
  averageAfter: 63.1,
  delta: -12.9,
  rows: [{ sessionId: 's-1', label: 'a.json', before: 74, after: 60, delta: -14 }],
}

function input(overrides: Partial<AgentReportInput> = {}): AgentReportInput {
  return {
    run: run(),
    sessions: [],
    pack: DEFAULT_PACK,
    model: 'test-model',
    endpoint: 'https://token.example.cn/v1/chat/completions',
    generatedAt: new Date('2026-10-24T04:00:00.000Z'),
    locale: 'zh-CN',
    ...overrides,
  }
}

describe('endpointHost', () => {
  it('keeps only the host so a signed proxy path never lands in a report', () => {
    expect(endpointHost('https://token.example.cn/v1/chat/completions?key=abc')).toBe('token.example.cn')
    expect(endpointHost('not a url')).toBe('not a url')
  })
})

describe('renderAgentMarkdown', () => {
  it('separates the model thesis from the tool evidence', () => {
    const markdown = renderAgentMarkdown(input())

    expect(markdown).toContain('# 轨迹诊断报告')
    expect(markdown).toContain('整体可用，短板在错误恢复。')
    // 免责声明必须在结论之前：读者先知道这段是模型说的。
    expect(markdown.indexOf('未经核验')).toBeLessThan(markdown.indexOf('整体可用'))
    expect(markdown).toContain('工具报错后直接放弃')
    expect(markdown).toContain('第 4 步')
    expect(markdown).toContain('exec-tool-error')
    expect(markdown).toContain('| 1 | list_sessions |')
  })

  it('shows the session label next to the id when the session is loaded', () => {
    const analyzed = analyze({
      source: JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
      label: 'a.json',
    })
    if (!analyzed.ok) throw new Error('fixture failed')
    const sessions = analyzed.value.sessions
    const id = sessions[0]?.id as string

    const markdown = renderAgentMarkdown(
      input({
        sessions,
        run: run({
          diagnosis: { verdict: 'v', rootCauses: [{ session: id, cause: '原因', evidence: '证据' }], actions: [] },
        }),
      }),
    )
    // 报告给人读：认得出的名字优先，id 只在找不到会话时才出现。
    expect(markdown).toContain('**a.json**')
    expect(markdown).not.toContain(id)
  })

  it('survives a diagnosis with missing optional text', () => {
    // 模型输出不可全信：缺 rationale / evidence 时只省略那一行，不该整份崩掉。
    const markdown = renderAgentMarkdown(
      input({
        run: run({
          diagnosis: {
            verdict: 'v',
            rootCauses: [{ cause: '原因' }],
            actions: [{ action: '动作' }],
          } as never,
        }),
      }),
    )
    expect(markdown).toContain('原因')
    expect(markdown).toContain('动作')
  })

  it('says plainly that the diagnosis did not converge', () => {
    const markdown = renderAgentMarkdown(
      input({
        run: run({
          trace: {
            entries: [],
            rounds: 8,
            toolCalls: 0,
            truncated: true,
            stopReason: 'rounds',
          },
        }),
      }),
    )
    expect(markdown).toContain('未收敛')
    expect(markdown).toContain('达到轮次上限')
    // 没有工具调用时不能静默留白
    expect(markdown).toContain('这次运行没有产生工具调用')
  })

  it('reports a failed run with its reason', () => {
    const markdown = renderAgentMarkdown(
      input({
        run: run({ ok: false, error: { code: 'analysis-failed', message: '模型请求失败（HTTP 500）' }, diagnosis: null }),
      }),
    )
    expect(markdown).toContain('运行失败')
    expect(markdown).toContain('HTTP 500')
    expect(markdown).toContain('模型没有给出结论')
  })

  it('keeps table rows intact when evidence contains a pipe', () => {
    const markdown = renderAgentMarkdown(
      input({
        run: run({
          trace: {
            entries: [{ kind: 'tool', round: 1, name: 'get_step', args: '{a|b}', ok: false, result: 'x|y', ms: 1 }],
            rounds: 1,
            toolCalls: 1,
            truncated: false,
            stopReason: 'answered',
          },
        }),
      }),
    )
    expect(markdown).toContain('a\\|b')
    expect(markdown).toContain('x\\|y')
  })
})

describe('proposals in the report', () => {
  it('shows a proposal section with its simulated numbers', () => {
    const markdown = renderAgentMarkdown(input({ run: run({ proposals: [PROPOSAL] }) }))

    expect(markdown).toContain('规则包提案')
    // 必须让人看见「这是候选」，不能读成「已经改了」。
    expect(markdown).toContain('提案不会自动生效')
    expect(markdown).toContain('执行维扣分偏轻')
    expect(markdown).toContain('`exec-dead-loop` → error')
    expect(markdown).toContain('平均分 76 → 63.1（-12.9）')
  })

  it('omits the section entirely when nothing was proposed', () => {
    const markdown = renderAgentMarkdown(input())
    expect(markdown).not.toContain('规则包提案')
  })

  it('keeps proposals in JSON without duplicating the whole pack', () => {
    const json = JSON.parse(renderAgentJson(input({ run: run({ proposals: [PROPOSAL] }) }))) as {
      proposals: { id: string; packName: string; delta: number; pack?: unknown }[]
    }
    expect(json.proposals).toHaveLength(1)
    expect(json.proposals[0]?.packName).toContain('提案 1')
    expect(json.proposals[0]?.delta).toBe(-12.9)
    // 完整包另存文件，避免同一份数据两处漂移
    expect(json.proposals[0]?.pack).toBeUndefined()
  })
})

describe('renderAgentJson', () => {
  it('keeps stable keys and only localises values', () => {
    const json = JSON.parse(renderAgentJson(input())) as Record<string, unknown>

    expect(Object.keys(json).sort()).toEqual(
      [
        'answer',
        'conclusion',
        'endpoint',
        'error',
        'generatedAt',
        'locale',
        'model',
        'ok',
        'pack',
        'proposals',
        'sessionCount',
        'status',
        'stopReason',
        'trace',
        'truncated',
        'usage',
      ].sort(),
    )
    expect(json.locale).toBe('zh-CN')
    expect(json.endpoint).toBe('token.example.cn')
    expect(json.status).toBe('已提交诊断')
    expect((json.conclusion as { verdict: string }).verdict).toContain('错误恢复')
  })

  it('localises the status without changing its key', () => {
    const zh = buildAgentReportModel(input())
    const en = buildAgentReportModel(input({ locale: 'en' }))
    expect(zh.status).toBe('已提交诊断')
    expect(en.status).toBe('Diagnosis submitted')
  })
})
