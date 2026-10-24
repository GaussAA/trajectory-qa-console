import { describe, expect, it, vi } from 'vitest'
import {
  canUseWorker,
  createAnalyzer,
  createSyncAnalyzer,
  createWorkerAnalyzer,
  type AnalyzerPort,
} from './analyzer'
import type { WorkerRequest } from '../workers/protocol'

class FakeWorker {
  listeners: Record<string, ((event: unknown) => void)[]> = {}
  sent: WorkerRequest[] = []
  terminated = false

  addEventListener(type: string, listener: (event: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener)
  }

  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
}

const VALID = JSON.stringify([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
])

const request = {
  text: VALID,
  label: 'demo.json',
  idPrefix: 'test',
}

describe('analyzer port', () => {
  it('analyses synchronously and reports timings', async () => {
    const result = await createSyncAnalyzer().analyze(request)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sessions).toHaveLength(1)
      expect(result.value.sessions[0]?.diagnostics.stepCount).toBe(2)
      expect(result.value.sessions[0]?.trajectory.label).toBe('demo.json')
    }
  })

  it('returns a Result on unusable input instead of throwing', async () => {
    const result = await createSyncAnalyzer().analyze({ ...request, text: 'not json' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-json')
  })

  it('has no worker adapter outside a browser', () => {
    expect(canUseWorker()).toBe(false)
    expect(createWorkerAnalyzer()).toBeNull()
  })

  it('times out a silent worker instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker()
      const port = createWorkerAnalyzer(() => worker as unknown as Worker, { timeoutMs: 20 })
      const promise = port?.analyze(request)
      vi.advanceTimersByTime(20)
      const result = await promise
      expect(result?.ok).toBe(false)
      if (result && !result.ok) expect(result.error.code).toBe('analysis-failed')
      expect(worker.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not write the worker off because one file was unanalysable', async () => {
    // 「每个会话都分析失败」是数据的问题，不是 worker 的问题：同样的输入在主线程也会失败。
    // 之前它也走 analysis-failed，于是一份坏文件就让 worker 在整个页面生命周期里被停用。
    let workerCalls = 0
    const analyzer = createAnalyzer({
      thresholdChars: 1,
      workerFactory: () => ({
        analyze: async () => {
          workerCalls += 1
          return { ok: false, error: { code: 'unrecognized-structure', message: '结构无法识别' } }
        },
      }),
    })

    const first = await analyzer.analyze(request)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.code).toBe('unrecognized-structure')

    await analyzer.analyze({ ...request, label: 'second.json' })
    // 两个文件都还是交给 worker 的
    expect(workerCalls).toBe(2)
  })

  it('keeps using the worker after a data-only analysis-failed result', async () => {
    let workerCalls = 0
    const analyzer = createAnalyzer({
      thresholdChars: 1,
      workerFactory: () => ({
        analyze: async () => {
          workerCalls += 1
          // 带 reason 的 analysis-failed：analyze() 里每个会话都抛了，是数据的错
          return { ok: false, error: { code: 'analysis-failed', message: 'x', detail: { reason: '指标计算炸了' } } }
        },
      }),
    })
    await analyzer.analyze(request)
    await analyzer.analyze(request)
    expect(workerCalls).toBe(2)
  })

  it('tags the failures that really are the worker’s fault', async () => {
    // 启动失败、崩溃、超时：这三种才是 worker 本身的问题
    const crashed = new FakeWorker()
    const crashPort = createWorkerAnalyzer(() => crashed as unknown as Worker)
    const crash = crashPort?.analyze(request)
    crashed.emit('error', { message: 'worker exploded' })
    const crashResult = await crash
    expect(crashResult && !crashResult.ok && crashResult.error.detail?.workerFault).toBe(true)

    const startFail = createWorkerAnalyzer(() => {
      throw new Error('blocked')
    })
    const startResult = await startFail?.analyze(request)
    expect(startResult && !startResult.ok && startResult.error.detail?.workerFault).toBe(true)

    vi.useFakeTimers()
    try {
      const silent = new FakeWorker()
      const timeoutPort = createWorkerAnalyzer(() => silent as unknown as Worker, { timeoutMs: 20 })
      const pending = timeoutPort?.analyze(request)
      vi.advanceTimersByTime(20)
      const timeoutResult = await pending
      expect(timeoutResult && !timeoutResult.ok && timeoutResult.error.detail?.workerFault).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying a broken worker after the first failure', async () => {
    let workerCalls = 0
    const analyzer = createAnalyzer({
      thresholdChars: 1,
      workerFactory: () => ({
        analyze: async () => {
          workerCalls += 1
          return { ok: false, error: { code: 'analysis-failed', message: 'broken', detail: { workerFault: true } } }
        },
      }),
    })

    const first = await analyzer.analyze(request)
    const second = await analyzer.analyze({ ...request, label: 'second.json' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(workerCalls).toBe(1)
  })

  it('speaks the worker protocol and terminates the thread', async () => {
    const worker = new FakeWorker()
    const port = createWorkerAnalyzer(() => worker as unknown as Worker)
    expect(port).not.toBeNull()

    const promise = port?.analyze(request)
    const message = worker.sent[0]
    expect(message?.label).toBe('demo.json')

    worker.emit('message', {
      data: {
        id: message?.id,
        result: { ok: true, value: { sessions: [], issues: [] } },
      },
    })

    const result = await promise
    expect(result?.ok).toBe(true)
    expect(worker.terminated).toBe(true)
    expect(worker.listeners.message).toHaveLength(0)
  })

  it('turns worker crashes into a Result', async () => {
    const worker = new FakeWorker()
    const port = createWorkerAnalyzer(() => worker as unknown as Worker)
    const promise = port?.analyze(request)

    worker.emit('error', { message: 'worker exploded' })
    const result = await promise
    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.error.code).toBe('analysis-failed')
    expect(worker.terminated).toBe(true)
  })

  it('cancels through the signal', async () => {
    const worker = new FakeWorker()
    const port = createWorkerAnalyzer(() => worker as unknown as Worker)
    const controller = new AbortController()
    const promise = port?.analyze(request, controller.signal)

    controller.abort()
    const result = await promise
    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.error.code).toBe('aborted')
    expect(worker.terminated).toBe(true)
  })

  it('uses the sync adapter for small inputs and the worker for large ones', async () => {
    let workerCalls = 0
    const workerFactory = (): AnalyzerPort => ({
      analyze: async () => {
        workerCalls += 1
        return { ok: true, value: { sessions: [], issues: [] } }
      },
    })

    const large = createAnalyzer({ thresholdChars: 10, workerFactory })
    await large.analyze(request)
    expect(workerCalls).toBe(1)

    const small = createAnalyzer({ thresholdChars: 10_000, workerFactory })
    const result = await small.analyze(request)
    expect(workerCalls).toBe(1)
    expect(result.ok).toBe(true)
  })

  it('degrades to sync when the worker fails', async () => {
    const analyzer = createAnalyzer({
      thresholdChars: 1,
      workerFactory: () => ({
        analyze: async () => ({
          ok: false,
          error: { code: 'analysis-failed', message: 'worker broke', detail: { workerFault: true } },
        }),
      }),
    })
    const result = await analyzer.analyze(request)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sessions).toHaveLength(1)
  })

  it('passes cancellation through to the worker adapter', async () => {
    const analyzer = createAnalyzer({
      thresholdChars: 1,
      workerFactory: () => ({
        analyze: async (_req, signal) =>
          signal?.aborted
            ? { ok: false, error: { code: 'aborted', message: '已取消分析' } }
            : { ok: true, value: { sessions: [], issues: [] } },
      }),
    })
    const controller = new AbortController()
    controller.abort()
    const result = await analyzer.analyze(request, controller.signal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')
  })
})
