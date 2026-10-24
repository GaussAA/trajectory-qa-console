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
  /** 模型引用的原文在它看到的摘要里找不到。已降为 info 并去掉那句引文。
   *  不是删掉：删掉就等于悄悄吞掉模型的判断；标出来，读者才知道这条没有依据。 */
  unverified?: boolean
}

/** 传输层已抽到 `core/llm`：语义复核与智能体共用同一套超时/重试纪律，
 *  这里只做转发，保持既有 import 路径可用。 */
export type { LlmRequest, LlmResponse, LlmTransport } from '../llm/transport'
export { fetchTransport } from '../llm/transport'
