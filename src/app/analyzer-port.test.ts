/** The analyzer port has two adapters. Two adapters make the seam real — and
 *  make it worth locking: both must answer the same question the same way.
 *
 *  These tests run the *same* cases through both adapters. The worker adapter
 *  is driven by a worker that genuinely executes the core pipeline, so a
 *  disagreement between the adapters cannot hide behind a stubbed result.
 */

import { describe, expect, it } from 'vitest'
import { createSyncAnalyzer, createWorkerAnalyzer, type AnalyzerPort } from './analyzer'
import { analyze as analyzeCore } from '../core/analysis'
import type { AnalyzeRequest } from './analyzer'
import type { SessionAnalysis } from '../core/analysis'
import type { WorkerRequest } from '../workers/protocol'

/** A worker that really analyses, answering on the next microtask. */
class EchoWorker {
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
    const result = analyzeCore({
      source: message.text,
      label: message.label,
      idPrefix: message.idPrefix,
      maxSteps: message.maxSteps,
    })
    queueMicrotask(() => {
      for (const listener of this.listeners['message'] ?? []) {
        listener({ data: { id: message.id, result } })
      }
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

const VALID = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', content: '好的' },
])
const BROKEN = '{not json'

function request(text: string): AnalyzeRequest {
  return { text, label: 'trace.json', idPrefix: 'port' }
}

function adapters(): { name: string; port: AnalyzerPort }[] {
  const { sync, worker } = pair()
  return [
    { name: 'sync', port: sync },
    { name: 'worker', port: worker },
  ]
}

/** One of each, for the tests that compare them head to head. */
function pair(): { sync: AnalyzerPort; worker: AnalyzerPort } {
  const port = createWorkerAnalyzer(() => new EchoWorker() as unknown as Worker)
  if (!port) throw new Error('expected a worker adapter')
  return { sync: createSyncAnalyzer(), worker: port }
}

/** Everything that must agree, minus timings (which legitimately differ). */
function shape(list: SessionAnalysis[]): unknown {
  return list.map((session) => ({
    id: session.id,
    label: session.trajectory.label,
    steps: session.trajectory.steps.length,
    parseNotes: session.trajectory.parseNotes,
    metrics: session.metrics,
  }))
}

describe('both analyzer adapters answer identically', () => {
  it.each(adapters())('$name analyses a valid trace', async ({ port }) => {
    const result = await port.analyze(request(VALID))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sessions).toHaveLength(1)
    expect(result.value.issues).toHaveLength(0)
    expect(result.value.sessions[0]?.trajectory.steps).toHaveLength(3)
  })

  it.each(adapters())('$name reports unusable input as a Result', async ({ port }) => {
    const result = await port.analyze(request(BROKEN))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-json')
  })

  it('sync and worker produce the same sessions for the same input', async () => {
    const { sync, worker } = pair()
    const a = await sync.analyze(request(VALID))
    const b = await worker.analyze(request(VALID))

    expect(a.ok).toBe(b.ok)
    if (!a.ok || !b.ok) return
    expect(shape(b.value.sessions)).toEqual(shape(a.value.sessions))
  })

  it('sync and worker agree on every sample that matters', async () => {
    const cases = [VALID, BROKEN, '[]', JSON.stringify({ not: 'a trace' })]
    const { sync, worker } = pair()

    for (const text of cases) {
      const a = await sync.analyze(request(text))
      const b = await worker.analyze(request(text))
      expect(a.ok, `ok for ${text}`).toBe(b.ok)
      if (a.ok && b.ok) {
        expect(shape(b.value.sessions), `shape for ${text}`).toEqual(shape(a.value.sessions))
      } else if (!a.ok && !b.ok) {
        expect(b.error.code, `code for ${text}`).toBe(a.error.code)
      }
    }
  })
})

describe('cancellation is reported the same way by both adapters', () => {
  it.each(adapters())('$name honours an already-aborted signal', async ({ port }) => {
    const controller = new AbortController()
    controller.abort()
    const result = await port.analyze(request(VALID), controller.signal)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('aborted')
  })

  it('the worker adapter also abandons an analysis already in flight', async () => {
    const worker = new EchoWorker()
    const port = createWorkerAnalyzer(() => worker as unknown as Worker)
    if (!port) throw new Error('expected a worker adapter')

    const controller = new AbortController()
    const promise = port.analyze(request(VALID), controller.signal)
    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')
    expect(worker.terminated).toBe(true)
  })
})
