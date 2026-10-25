// @vitest-environment jsdom
/** Import behaviour lives in the controller, not in App — so it is tested here.
 *
 *  The drag-and-drop entry point cannot be driven from jsdom (React's drop
 *  event never fires there), which is exactly why the bug these tests cover
 *  went unnoticed for so long: nothing was exercising this path at all. */

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { INGEST_LIMITS, type IngestFile } from '../app/ingest'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import { I18nProvider } from '../i18n'
import { useWorkspaceController } from './useWorkspaceController'

function setup() {
  const telemetry = createTelemetry()
  const view = renderHook(
    () =>
      useWorkspaceController({
        analyzer: createSyncAnalyzer(),
        persistence: createPersistence(createMemoryStorage()),
        telemetry,
      }),
    { wrapper: ({ children }) => <I18nProvider initialLocale="zh-CN">{children}</I18nProvider> },
  )
  return { ...view, telemetry }
}

/** A real, analysable trace — an empty JSON array parses but yields nothing. */
const TRACE = JSON.stringify([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'ok' },
])
const ok: IngestFile = { name: 'ok.json', size: TRACE.length, text: async () => TRACE }

function tooLarge(): IngestFile {
  return { name: 'huge.json', size: INGEST_LIMITS.maxFileBytes + 1, text: async () => '[]' }
}

describe('import reports every problem it had', () => {
  it('keeps a rejected file visible when the other files loaded fine', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([...Array.from({ length: 3 }, () => ok), tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.sessions.length).toBeGreaterThan(0))

    // The good sessions still load — and the bad file is *reported*, not
    // silently dropped. It used to vanish whenever at least one file loaded.
    expect(result.current.state.sessions.length).toBeGreaterThan(0)
    expect(result.current.state.issues.map((issue) => issue.code)).toEqual(['too-large'])
    expect(result.current.state.issues[0]?.file).toBe('huge.json')
  })

  it('carries the numbers the message needs', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([ok, tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.issues.length).toBeGreaterThan(0))

    const issue = result.current.state.issues[0]
    expect(issue?.params?.size).toBeTruthy()
    expect(issue?.params?.limit).toBeTruthy()
    // The dictionary entry needs both; a fallback string is not good enough.
    expect(issue?.code).toBe('too-large')
  })

  it('reports the file count limit alongside the files that did load', async () => {
    const { result } = setup()
    const files = [
      ...Array.from({ length: INGEST_LIMITS.maxFiles }, () => ok),
      { name: 'extra.json', size: 2, text: async () => '[]' } satisfies IngestFile,
    ]

    await act(async () => {
      void result.current.actions.ingestFiles(files)
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.issues.length).toBeGreaterThan(0))

    expect(result.current.state.issues.map((issue) => issue.code)).toEqual(['too-many'])
    expect(result.current.state.issues[0]?.params).toMatchObject({ limit: INGEST_LIMITS.maxFiles, extra: 1 })
  })

  it('keeps the specific reason instead of collapsing every failure', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([{ name: 'bad.json', size: 8, text: async () => '{not json' }])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.issues.length).toBeGreaterThan(0))

    // Not a generic "analysis failed": the dictionary has an entry for this
    // exact failure, and the user should be told which one it was.
    expect(result.current.state.issues[0]?.code).toBe('invalid-json')
  })

  it('still fails loudly when nothing at all could be read', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.lastError).toBeTruthy())

    // Failure is recorded on lastError; the phase stays put so whatever was
    // already loaded remains on screen.
    expect(result.current.state.lastError?.code).toBe('analysis-failed')
    expect(result.current.state.sessions).toHaveLength(0)
  })
})

describe('adoptProposal', () => {
  it('applies the pack and keeps the previous one as a variant', async () => {
    const { result } = setup()
    await act(async () => {
      void result.current.actions.ingestFiles([ok])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.sessions).toHaveLength(1))

    const before = result.current.state.pack
    const candidate = { ...before, name: '提案包' }

    act(() => {
      result.current.actions.adoptProposal(candidate, 'p1')
    })

    expect(result.current.state.pack.name).toBe('提案包')
    // 后悔药：旧口径必须留得下来，否则一键改全局口径太危险。
    expect(result.current.state.variants).toHaveLength(1)
    expect(result.current.state.variants[0]?.pack.name).toBe(before.name)
    expect(result.current.toast).toMatchObject({ key: 'toast.proposalApplied' })
  })
})

describe('pack variants survive a reload', () => {
  function mount(storage: ReturnType<typeof createMemoryStorage>) {
    return renderHook(
      () =>
        useWorkspaceController({
          analyzer: createSyncAnalyzer(),
          persistence: createPersistence(storage),
          telemetry: createTelemetry(),
        }),
      { wrapper: ({ children }) => <I18nProvider initialLocale="zh-CN">{children}</I18nProvider> },
    )
  }

  it('restores a saved variant when the controller is mounted again', () => {
    const storage = createMemoryStorage()

    const first = mount(storage)
    act(() => {
      first.result.current.actions.saveVariant('严格口径', first.result.current.state.pack)
    })
    expect(first.result.current.state.variants).toHaveLength(1)
    first.unmount()

    const second = mount(storage)
    expect(second.result.current.state.variants).toHaveLength(1)
    expect(second.result.current.state.variants[0]?.name).toBe('严格口径')
  })

  it('does not resurrect a variant that was removed before the reload', () => {
    const storage = createMemoryStorage()

    const first = mount(storage)
    let id = ''
    act(() => {
      id = first.result.current.actions.saveVariant('临时', first.result.current.state.pack)?.id ?? ''
    })
    act(() => {
      first.result.current.actions.removeVariant(id)
    })
    first.unmount()

    expect(mount(storage).result.current.state.variants).toHaveLength(0)
  })
})

describe('exportAgentReport', () => {
  const RUN = {
    ok: true,
    diagnosis: {
      verdict: '短板在工具错误恢复。',
      rootCauses: [{ cause: '报错后放弃', evidence: '第 2 步' }],
      actions: [{ action: '提高扣分', rationale: '试跑后均值下降' }],
    },
    answer: '',
    proposals: [],
    trace: {
      entries: [
        { kind: 'tool' as const, round: 1, name: 'list_sessions', args: '{}', ok: true, result: '{}', ms: 2 },
      ],
      rounds: 1,
      toolCalls: 1,
      truncated: false,
      stopReason: 'submitted' as const,
    },
    usage: { prompt: 10, completion: 5 },
  }

  it('writes a standalone diagnosis report, not the score report', async () => {
    const { result } = setup()
    const blobs: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    // jsdom 没有这两个：不 mock 的话 downloadFile 里 2s 后的 revoke 会炸。
    URL.createObjectURL = ((blob: Blob) => {
      blobs.push(blob)
      return 'blob:mock'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = () => undefined

    try {
      act(() => {
        result.current.actions.receiveAgentRun({
          run: RUN,
          model: 'sensenova-test',
          endpoint: 'http://127.0.0.1:7788',
        })
      })
      await act(async () => {
        result.current.actions.exportAgentReport('md')
        await Promise.resolve()
      })

      const text = await blobs[0]!.text()
      expect(text).toContain('# 轨迹诊断报告')
      expect(text).toContain('sensenova-test')
      expect(text).toContain('短板在工具错误恢复')
      // 诊断报告的免责声明必须在，否则模型的话会被当成核验过的结论。
      expect(text).toContain('未经核验')
      expect(result.current.toast).toMatchObject({ key: 'toast.agentReportExported' })
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
})
