// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyze, type SessionAnalysis } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { I18nProvider } from '../i18n'
import { AgentPanel } from './AgentPanel'

function sessions(): SessionAnalysis[] {
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
  return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { status: 200 })
}

const RUN = {
  ok: true,
  diagnosis: {
    verdict: '两条会话的短板都在工具错误恢复。',
    rootCauses: [{ cause: '工具报错后直接放弃', evidence: '第 2 步' }],
    actions: [{ action: '提高扣分', ruleId: 'exec-tool-error' }],
  },
  answer: '',
  proposals: [],
  trace: { entries: [], rounds: 2, toolCalls: 3, truncated: false, stopReason: 'submitted' },
  usage: { prompt: 10, completion: 5 },
}

function setup(target: Parameters<typeof AgentPanel>[0]['target']) {
  return render(
    <I18nProvider initialLocale="zh-CN">
      <AgentPanel
        open
        target={target}
        sessions={sessions()}
        pack={DEFAULT_PACK}
        onClose={() => undefined}
      />
    </I18nProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentPanel', () => {
  it('explains how to start the service when the URL has no ?agent', () => {
    setup(null)
    expect(screen.getByText('连不上本地服务')).toBeTruthy()
    expect(screen.getByText('trajectory-qa serve')).toBeTruthy()
    // 按钮还在（让人知道有这个功能），但是禁用的——点了必然失败的事不该能点。
    const start = screen.getByRole('button', { name: /开始诊断/ }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
  })

  it('runs a diagnosis and renders verdict, causes and actions', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamOf([
          { type: 'start', sessions: 1 },
          { type: 'progress', event: { kind: 'round', round: 1, toolCalls: 1 } },
          { type: 'progress', event: { kind: 'tool', round: 1, name: 'list_sessions', ok: true, ms: 2 } },
          { type: 'done', run: RUN },
        ]),
      ),
    )

    setup({ endpoint: 'http://127.0.0.1:7788', token: null })
    await user.click(screen.getByRole('button', { name: /开始诊断/ }))

    expect(await screen.findByText(/工具错误恢复/)).toBeTruthy()
    expect(screen.getByText('工具报错后直接放弃')).toBeTruthy()
    expect(screen.getByText('提高扣分')).toBeTruthy()
    // 模型归纳与工具事实必须分开呈现，否则读者会以为结论里的数字是核验过的。
    expect(screen.getByText(/未经核验/)).toBeTruthy()
  })

  it('cancels an in-flight request and returns to idle', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )

    setup({ endpoint: 'http://127.0.0.1:7788', token: null })
    await user.click(screen.getByRole('button', { name: /开始诊断/ }))
    await screen.findByText(/诊断中/)

    await user.click(screen.getByRole('button', { name: /取消/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /开始诊断/ })).toBeTruthy())
  })

  it('distinguishes a stopped service from a server error', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    setup({ endpoint: 'http://127.0.0.1:7788', token: null })
    await user.click(screen.getByRole('button', { name: /开始诊断/ }))

    expect(await screen.findByText('连不上本地服务')).toBeTruthy()
    expect(screen.getByText('trajectory-qa serve')).toBeTruthy()
  })
})
