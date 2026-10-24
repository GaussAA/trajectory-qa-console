/** Analyzer port: one interface, two adapters.
 *
 *  - sync adapter: the default for small traces, tests and environments without
 *    Workers (jsdom, older browsers);
 *  - worker adapter: keeps the main thread free for anything large enough to be
 *    felt, and can be cancelled.
 *
 *  Two adapters justify the seam. The composition below degrades to sync if the
 *  worker cannot start or fails mid-flight.
 */

import { analyze as analyzeCore, type AnalyzeOutcome } from '../core/analysis'
import { fail, type Result } from '../core/model'
import AnalyzeWorker from '../workers/analyze.worker?worker&inline'
import type { WorkerRequest, WorkerResponse } from '../workers/protocol'

/** Parsing and metrics only. The rule pack belongs to scoring (`buildCard`),
 *  not to analysis, so it is deliberately absent here. */
export interface AnalyzeRequest {
  text: string
  label: string
  idPrefix: string
  maxSteps?: number
}

export interface AnalyzerPort {
  /** Cancellation semantics are part of this interface, and they differ by
   *  adapter in one respect only: the worker adapter can also abandon an
   *  analysis already in flight, whereas the sync adapter — being synchronous —
   *  can only honour a signal that was already aborted when it was called.
   *  Both report it the same way: `{ code: 'aborted' }`. */
  analyze(request: AnalyzeRequest, signal?: AbortSignal): Promise<Result<AnalyzeOutcome>>
}

export const WORKER_THRESHOLD_CHARS = 256 * 1024

export function createSyncAnalyzer(): AnalyzerPort {
  return {
    async analyze(request, signal) {
      // Synchronous by nature, so this is the only point at which a signal can
      // still be honoured — but it must be, or the two adapters disagree.
      if (signal?.aborted) return fail('aborted', 'Cancelled')
      try {
        return analyzeCore({
          source: request.text,
          label: request.label,
          idPrefix: request.idPrefix,
          maxSteps: request.maxSteps,
        })
      } catch (error) {
        return fail('analysis-failed', 'Analysis failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

let requestSequence = 0

/** Injectable so tests can exercise the protocol without a real Worker. */
export type WorkerFactory = () => Worker

export interface WorkerAnalyzerOptions {
  /** A worker that never answers must not hang the UI forever. */
  timeoutMs?: number
}

/** Blob workers are blocked on `file://` (origin "null"), which is exactly how
 *  the single-file build is usually opened. Probe the environment instead of
 *  discovering it by hanging. */
export function canUseWorker(): boolean {
  if (typeof Worker === 'undefined') return false
  if (typeof location !== 'undefined' && location.protocol === 'file:') return false
  return true
}

export function createWorkerAnalyzer(
  createWorker?: WorkerFactory,
  options: WorkerAnalyzerOptions = {},
): AnalyzerPort | null {
  if (!createWorker && !canUseWorker()) return null
  const factory: WorkerFactory = createWorker ?? (() => new AnalyzeWorker())
  const timeoutMs = options.timeoutMs ?? 8000

  return {
    analyze(request, signal) {
      return new Promise<Result<AnalyzeOutcome>>((resolve) => {
        let worker: Worker
        try {
          worker = factory()
        } catch (error) {
          resolve(
            fail('analysis-failed', 'Worker could not start', {
              reason: error instanceof Error ? error.message : String(error),
              workerFault: true,
            }),
          )
          return
        }

        const id = (requestSequence += 1)
        const disposers: (() => void)[] = []

        const onMessage = (event: MessageEvent<WorkerResponse>) => {
          if (event.data?.id !== id) return
          finish(event.data.result)
        }
        const onError = (event: ErrorEvent) => {
          finish(fail('analysis-failed', event.message || 'Worker failed', { workerFault: true }))
        }
        const onAbort = () => {
          finish(fail('aborted', 'Cancelled'))
        }
        const cleanup = () => {
          for (const dispose of disposers) dispose()
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          signal?.removeEventListener('abort', onAbort)
        }
        const finish = (result: Result<AnalyzeOutcome>) => {
          cleanup()
          worker.terminate()
          resolve(result)
        }

        worker.addEventListener('message', onMessage)
        worker.addEventListener('error', onError)

        if (signal?.aborted) {
          finish(fail('aborted', 'Cancelled'))
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        const watchdog = setTimeout(() => {
          finish(fail('analysis-failed', `No response within ${timeoutMs}ms; degraded`, { workerFault: true }))
        }, timeoutMs)
        disposers.push(() => clearTimeout(watchdog))

        const message: WorkerRequest = {
          id,
          text: request.text,
          label: request.label,
          idPrefix: request.idPrefix,
          maxSteps: request.maxSteps,
        }
        worker.postMessage(message)
      })
    },
  }
}

export interface AnalyzerOptions {
  forceSync?: boolean
  thresholdChars?: number
  workerFactory?: () => AnalyzerPort | null
}

export function createAnalyzer(options: AnalyzerOptions = {}): AnalyzerPort {
  const sync = createSyncAnalyzer()
  const worker = options.forceSync ? null : (options.workerFactory?.() ?? createWorkerAnalyzer())
  const threshold = options.thresholdChars ?? WORKER_THRESHOLD_CHARS
  let workerHealthy = worker !== null

  return {
    async analyze(request, signal) {
      if (worker && workerHealthy && request.text.length > threshold) {
        const result = await worker.analyze(request, signal)
        // Degrade rather than fail: a worker problem must not cost the user data.
        // Only a *worker* fault (could not start, crashed, went silent) counts. An
        // `analysis-failed` that came back from analyze() itself — every session threw —
        // is about the data: the main thread would fail the same way, and writing the
        // worker off for the rest of the page's life over one bad file is wrong.
        if (!result.ok && result.error.detail?.workerFault === true) {
          // Remember the failure so the next file does not pay the timeout again.
          workerHealthy = false
          return sync.analyze(request, signal)
        }
        return result
      }
      return sync.analyze(request, signal)
    },
  }
}
