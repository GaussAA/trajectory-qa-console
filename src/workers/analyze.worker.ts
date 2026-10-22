/// <reference types="vite/client" />

import { analyze } from '../core/analysis'
import type { WorkerRequest, WorkerResponse } from './protocol'

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  const { id, text, label, pack, idPrefix, maxSteps } = event.data
  const result = analyze({ source: text, label, pack, idPrefix, maxSteps })
  scope.postMessage({ id, result })
}
