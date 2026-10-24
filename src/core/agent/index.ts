/** 智能体诊断：入口只有 `runAgent`，其余是给它组装零件用的。
 *
 *  与 `core/semantic` 的分工：语义复核产出 finding、进评分卡；诊断产出**解释**，
 *  不进任何分数（invariant 3 要求分数纯派生，不能被模型漂移污染）。
 */

export { runAgent, type AgentOptions } from './loop'
export { chat, parseReply, type ChatOptions } from './chat'
export { TOOLS, TERMINAL_TOOL, parseDiagnosis, toolByName, toolSpecs } from './tools'
export { buildAgentMessages, buildSystemPrompt, type AgentTaskInput } from './prompt'
export { AGENT_BUDGET } from './types'
export type * from './types'
