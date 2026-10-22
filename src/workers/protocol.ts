import type { SessionAnalysis } from '../core/analysis'
import type { Result } from '../core/model'

export interface WorkerRequest {
  id: number
  text: string
  label: string
  pack: import('../core/model').RulePack
  idPrefix: string
  maxSteps?: number
}

export interface WorkerResponse {
  id: number
  result: Result<SessionAnalysis[]>
}
