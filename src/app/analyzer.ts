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

import { analyze as analyzeCore, type SessionAnalysis } from '../core/analysis'
import { fail, type Result, type RulePack } from '../core/model'
import AnalyzeWorker from '../workers/analyze.worker?worker&inline'
import type { WorkerRequest, WorkerResponse } from '../workers/protocol'

export interface AnalyzeRequest {
  text: string
  label: string
  pack: RulePack
  idPrefix: string
  maxSteps?: number
}

export interface AnalyzerPort {
  analyze(request: AnalyzeRequest, signal?: AbortSignal): Promise<Result<SessionAnalysis[]>>
}

export const WORKER_THRESHOLD_CHARS = 256 * 1024

export function createSyncAnalyzer(): AnalyzerPort {
  return {
    async analyze(request) {
      try {
        return analyzeCore({
          source: request.text,
          label: request.label,
          pack: request.pack,
          idPrefix: request.idPrefix,
          maxSteps: request.maxSteps,
        })
      } catch (error) {
        return fail('analysis-failed', '分析过程出错', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

let requestSequence = 0

/** Injectable so tests can exercise the protocol without a real Worker. */
export type WorkerFactory = () => Worker

export function createWorkerAnalyzer(createWorker?: WorkerFactory): AnalyzerPort | null {
  if (!createWorker && typeof Worker === 'undefined') return null
  const factory: WorkerFactory = createWorker ?? (() => new AnalyzeWorker())

  return {
    analyze(request, signal) {
      return new Promise<Result<SessionAnalysis[]>>((resolve) => {
        let worker: Worker
        try {
          worker = factory()
        } catch (error) {
          resolve(
            fail('analysis-failed', '无法启动分析线程', {
              reason: error instanceof Error ? error.message : String(error),
            }),
          )
          return
        }

        const id = (requestSequence += 1)

        const onMessage = (event: MessageEvent<WorkerResponse>) => {
          if (event.data?.id !== id) return
          finish(event.data.result)
        }
        const onError = (event: ErrorEvent) => {
          finish(fail('analysis-failed', event.message || '分析线程执行失败'))
        }
        const onAbort = () => {
          finish(fail('aborted', '已取消分析'))
        }
        const cleanup = () => {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          signal?.removeEventListener('abort', onAbort)
        }
        const finish = (result: Result<SessionAnalysis[]>) => {
          cleanup()
          worker.terminate()
          resolve(result)
        }

        worker.addEventListener('message', onMessage)
        worker.addEventListener('error', onError)

        if (signal?.aborted) {
          finish(fail('aborted', '已取消分析'))
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        const message: WorkerRequest = {
          id,
          text: request.text,
          label: request.label,
          pack: request.pack,
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

  return {
    async analyze(request, signal) {
      if (worker && request.text.length > threshold) {
        const result = await worker.analyze(request, signal)
        // Degrade rather than fail: a worker problem must not cost the user data.
        if (!result.ok && result.error.code === 'analysis-failed') {
          return sync.analyze(request, signal)
        }
        return result
      }
      return sync.analyze(request, signal)
    },
  }
}
