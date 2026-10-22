/** 语义复核：可选、可注入、可降级。
 *
 *  入口只有 `judgeTrajectory` 与 `toFindings`：前者把轨迹变成模型判定，
 *  后者把判定变成能进评分卡的 finding。其余都是内部细节。
 */

export { buildDigest, buildMessages, pickSteps, DIGEST_DEFAULTS, SYSTEM_PROMPT } from './prompt'
export { extractJson, parseJudgement } from './parse'
export { extractContent, judgeTrajectory, type JudgeOptions } from './judge'
export { SEMANTIC_IMPACT, categoryLabel, ruleIdFor, toFindings } from './merge'
export {
  SEMANTIC_CATEGORIES,
  fetchTransport,
  type LlmRequest,
  type LlmResponse,
  type LlmTransport,
  type SemanticCategory,
  type SemanticFinding,
} from './types'
