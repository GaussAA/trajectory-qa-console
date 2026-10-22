/** Structured, in-memory telemetry.
 *
 *  A single-file offline tool cannot ship events to a server, so "observability"
 *  means: every meaningful step leaves a record with a timestamp and a duration,
 *  the last N records survive, and the user can export them. That turns "it felt
 *  slow / it broke" into a diagnosis.
 */

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error'

export interface TelemetryEvent {
  seq: number
  at: number
  level: TelemetryLevel
  name: string
  durationMs?: number
  data?: Record<string, unknown>
}

export type TelemetryListener = (event: TelemetryEvent) => void

export interface Telemetry {
  emit(name: string, data?: Record<string, unknown>, level?: TelemetryLevel): void
  /** Runs `fn`, emitting `<name>` with the measured duration (and the error). */
  measure<T>(name: string, fn: () => T, data?: Record<string, unknown>): T
  snapshot(): TelemetryEvent[]
  clear(): void
  subscribe(listener: TelemetryListener): () => void
  child(scope: string): Telemetry
}

export interface TelemetryOptions {
  limit?: number
  clock?: () => number
  wallClock?: () => number
}

const DEFAULT_LIMIT = 500

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error: error.name, message: error.message }
  }
  return { error: String(error) }
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const limit = options.limit ?? DEFAULT_LIMIT
  const clock = options.clock ?? (() => Date.now())
  const wallClock = options.wallClock ?? (() => Date.now())
  const events: TelemetryEvent[] = []
  const listeners = new Set<TelemetryListener>()
  let sequence = 0

  const emit: Telemetry['emit'] = (name, data, level = 'info') => {
    const event: TelemetryEvent = {
      seq: (sequence += 1),
      at: wallClock(),
      level,
      name,
      ...(data ? { data } : {}),
    }
    events.push(event)
    if (events.length > limit) events.splice(0, events.length - limit)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // a broken listener must never break the thing it observes
      }
    }
  }

  const telemetry: Telemetry = {
    emit,
    measure(name, fn, data) {
      const started = clock()
      try {
        const value = fn()
        emit(name, { ...data, durationMs: Math.round((clock() - started) * 100) / 100 })
        return value
      } catch (error) {
        emit(
          name,
          { ...data, durationMs: Math.round((clock() - started) * 100) / 100, ...serializeError(error) },
          'error',
        )
        throw error
      }
    },
    snapshot: () => [...events],
    clear: () => {
      events.length = 0
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    child(scope) {
      return {
        ...telemetry,
        emit: (name, data, level) => emit(`${scope}:${name}`, data, level),
        measure: (name, fn, data) => telemetry.measure(`${scope}:${name}`, fn, data),
      }
    },
  }

  return telemetry
}

/** Captures uncaught errors and unhandled rejections. Returns an uninstall fn. */
export function installGlobalErrorHandlers(
  telemetry: Telemetry,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onError = (event: ErrorEvent) => {
    telemetry.emit(
      'window:error',
      { message: event.message, source: event.filename, line: event.lineno },
      'error',
    )
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason
    telemetry.emit(
      'window:unhandledrejection',
      reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason: String(reason) },
      'error',
    )
  }

  target.addEventListener('error', onError as EventListener)
  target.addEventListener('unhandledrejection', onRejection as EventListener)

  return () => {
    target.removeEventListener('error', onError as EventListener)
    target.removeEventListener('unhandledrejection', onRejection as EventListener)
  }
}

/** Plain-text export used by the diagnostics drawer. */
export function serializeEvents(events: TelemetryEvent[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), events }, null, 2)
}
