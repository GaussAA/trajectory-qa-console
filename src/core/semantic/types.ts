/** 语义复核的领域词汇：类别、模型输出的形状、以及可注入的传输层。 */

import type { Severity } from '../model'

export type SemanticCategory = 'off_topic' | 'unsupported_claim' | 'overreach' | 'incoherent' | 'unsafe'

export const SEMANTIC_CATEGORIES: SemanticCategory[] = [
  'off_topic',
  'unsupported_claim',
  'overreach',
  'incoherent',
  'unsafe',
]

/** 模型返回的一条判定；`step` 是 1 基步号（与提示词一致），落地时再转 0 基。 */
export interface SemanticFinding {
  category: SemanticCategory
  step?: number
  severity: Severity
  quote?: string
  reason: string
}

export interface LlmRequest {
  url: string
  model: string
  apiKey: string
  body: string
  signal?: AbortSignal
}

export interface LlmResponse {
  ok: boolean
  status: number
  text: string
}

/** 传输层可注入：测试用假实现，运行时用 fetch。 */
export type LlmTransport = (request: LlmRequest) => Promise<LlmResponse>

export const fetchTransport: LlmTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${request.apiKey}`,
    },
    body: request.body,
    signal: request.signal,
  })
  return { ok: response.ok, status: response.status, text: await response.text() }
}
