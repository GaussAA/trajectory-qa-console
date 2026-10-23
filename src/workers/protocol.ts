import type { AnalyzeOutcome } from '../core/analysis'
import type { Result } from '../core/model'

export interface WorkerRequest {
  id: number
  text: string
  label: string
  idPrefix: string
  maxSteps?: number
}

export interface WorkerResponse {
  id: number
  result: Result<AnalyzeOutcome>
}
