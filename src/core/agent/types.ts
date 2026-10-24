/** 智能体的领域词汇：消息、工具、预算、轨迹（trace）与诊断结论。
 *
 *  这里刻意**不**包含任何"怎么调模型"的细节（那是 `chat.ts`）与"有哪些工具"
 *  （那是 `tools.ts`）。这么切是因为循环要能被假模型完整驱动：测试只依赖本文件
 *  的类型，不需要知道端点长什么样。
 *
 *  线格式（wire format）照抄 OpenAI 规范，不自己发明：`tool_calls` / `finish_reason`
 *  / `role: 'tool'`。这些名字是事实标准，改名只会让对接新供应商时多一层翻译。
 */

import type { Annotation, RulePack, Severity } from '../model'
import type { ScoreCard, SessionAnalysis } from '../analysis'

// ---------- 消息 ----------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 模型发起的一次工具调用；`arguments` 保持原始字符串——
 *  它不是合法 JSON 时也要能原样回灌，让模型自己看见错在哪。 */
export interface AgentToolCall {
  id: string
  name: string
  arguments: string
}

export interface AgentMessage {
  role: MessageRole
  content: string
  /** 仅 assistant：本轮请求的工具。 */
  toolCalls?: AgentToolCall[]
  /** 仅 tool：回答的是哪个调用。 */
  toolCallId?: string
}

export interface ChatReply {
  content: string
  toolCalls: AgentToolCall[]
  finishReason: string | null
  /** 思考文本长度：只用于诊断与预算告警，绝不进结论。 */
  reasoningChars: number
  usage: { prompt: number; completion: number }
}

// ---------- 工具 ----------

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema（`type: 'object'`），原样发给模型的 `tools[].function.parameters`。 */
  parameters: Record<string, unknown>
}

export interface ToolOutcome {
  ok: boolean
  /** 回灌给模型的文本。约定为 JSON 字符串，便于模型读结构。 */
  content: string
}

export interface ToolContext {
  sessions: SessionAnalysis[]
  pack: RulePack
  annotations: Annotation[]
  /** 一次诊断内复用评分卡：24 次工具调用不该把同一套规则跑 24 遍。
   *  规则包在整轮里不变，所以按会话 id 索引就够。 */
  cards?: Map<string, ScoreCard>
  /** 提案收集器：`propose_pack` 把候选包放进来，运行结束后随结果交出。
   *  用可变上下文而不是让工具返回 artifact，是为了让提案与模拟共用同一次计算。 */
  proposals?: PackProposal[]
}

// ---------- 规则包提案 ----------

/** 对单条规则的改动。与 `simulate_pack` 同一形状——提案就是「被采纳的模拟」。 */
export interface RuleEdit {
  ruleId: string
  scoreImpact?: number
  enabled?: boolean
  severity?: Severity
  expr?: string
}

/** 改完之后这条规则实际扣多少。由工具算，不让模型自己乘严重度系数。 */
export interface AppliedEdit {
  ruleId: string
  severity: Severity
  scoreImpact: number
  effectiveImpact: number
}

export interface ProposalRow {
  sessionId: string
  label: string
  before: number
  after: number
  delta: number
}

/** 一份候选规则包。**不会自动生效**：落不落地由人决定（CLI 写文件、界面走抽屉导入）。 */
export interface PackProposal {
  id: string
  rationale: string
  edits: RuleEdit[]
  /** 改动生效后的实际严重度与扣分，由工具算好，报告直接引用。 */
  applied: AppliedEdit[]
  /** 完整候选包（已过 `validatePack`），可直接当 `--pack` 的参数。 */
  pack: RulePack
  averageBefore: number
  averageAfter: number
  delta: number
  rows: ProposalRow[]
}

export interface Tool {
  spec: ToolSpec
  /** 终结工具：一旦被调用，循环结束，其参数即最终结论。 */
  terminal?: boolean
  run: (args: Record<string, unknown>, context: ToolContext) => ToolOutcome
}

// ---------- 预算 ----------

export interface AgentBudget {
  /** 最多几轮「模型 → 工具」。 */
  maxRounds: number
  /** 最多执行几次工具（一轮可能请求多个）。 */
  maxToolCalls: number
  /** 整轮诊断的墙钟上限。 */
  maxDurationMs: number
  /** 单次请求超时。 */
  timeoutMs: number
  /** 单次输出预算：推理型模型会先花在思考上，不设会被截成空内容。 */
  maxTokens: number
}

export const AGENT_BUDGET: AgentBudget = {
  maxRounds: 8,
  maxToolCalls: 24,
  maxDurationMs: 180_000,
  timeoutMs: 90_000,
  maxTokens: 4096,
}

// ---------- trace ----------

export type StopReason = 'answered' | 'submitted' | 'rounds' | 'tool-calls' | 'duration' | 'output-limit'

export type TraceEntry =
  | {
      kind: 'model'
      round: number
      content: string
      toolCalls: number
      reasoningChars: number
      ms: number
    }
  | {
      kind: 'tool'
      round: number
      name: string
      args: string
      ok: boolean
      result: string
      ms: number
    }

export interface AgentTrace {
  entries: TraceEntry[]
  rounds: number
  toolCalls: number
  /** true 表示没走到自然收尾（预算/轮次耗尽），结论不完整，必须如实标注。 */
  truncated: boolean
  stopReason: StopReason
}

// ---------- 进度事件 ----------

/** 循环内的进度信号：界面靠它显示「第几轮、调了什么」。
 *  只报事实，不报模型文本——那个在最后一次性给出，免得半截话被当成结论。 */
export type AgentEvent =
  | { kind: 'round'; round: number; toolCalls: number }
  | { kind: 'tool'; round: number; name: string; ok: boolean; ms: number }

// ---------- 结论 ----------

export interface DiagnosisRootCause {
  /** 会话 id；跨会话的共性问题可省略。 */
  session?: string
  cause: string
  /** 证据：必须指向轨迹里的具体步或某次工具调用的返回值。 */
  evidence: string
}

export interface DiagnosisAction {
  action: string
  rationale: string
  /** 涉及规则时给出 id，便于人去抽屉里改。 */
  ruleId?: string
}

export interface Diagnosis {
  verdict: string
  rootCauses: DiagnosisRootCause[]
  actions: DiagnosisAction[]
}

/**
 * 一次诊断的完整结果。
 *
 * 不用 `Result` 包装是刻意的：失败的运行同样有 trace，而"为什么没得出结论"
 * 恰恰要靠 trace 回答。把它折成一个 `{ ok: false }` 等于把唯一的证据丢掉。
 */
export interface AgentRun {
  ok: boolean
  /** 失败原因（端点/超时/取消）。成功时为 undefined。 */
  error?: { code: string; message: string }
  diagnosis: Diagnosis | null
  /** 未调用终结工具时，模型最后的自由文本。 */
  answer: string
  /** 模型提出的规则包候选。空数组表示它认为现有口径不必改。 */
  proposals: PackProposal[]
  trace: AgentTrace
  usage: { prompt: number; completion: number }
}
