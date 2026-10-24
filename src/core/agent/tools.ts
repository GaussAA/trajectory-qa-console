/** 工具集：模型能做的每一件事，都落到一个已有的纯函数上。
 *
 *  设计上只有一条硬纪律——**数字只能来自这里**。模型可以选、可以归因、可以提议，
 *  但不能自己算：报告里的分数、命中数、模拟涨幅全部由这些工具产出，因此可审计。
 *
 *  全部工具都是只读或纯计算：没有一个会改动工作区、规则包或轨迹文件。
 *  `simulate_pack` 造的是**草稿包**，只存在于这次调用里，且必须过 `validatePack`。
 */

import { buildCard, scoreSession, type ScoreCard, type SessionAnalysis } from '../analysis'
import { compareCards, diffFindings } from '../compare'
import { formatPackErrors, validatePack } from '../rules/contract'
import { numericLiterals, replaceLiteral } from '../rules/tuning'
import { DIGEST_DEFAULTS, renderStep } from '../semantic/prompt'
import { SEVERITY_FACTOR, type RulePack, type Severity, type Step } from '../model'
import type {
  AppliedEdit,
  Diagnosis,
  PackProposal,
  ProposalRow,
  RuleEdit,
  Tool,
  ToolContext,
  ToolOutcome,
} from './types'

/** 单个工具结果的上限：一次返回几千行步详情会把上下文一次烧光，
 *  之后所有轮次都在读不完整的信息里瞎猜。 */
const MAX_RESULT_CHARS = 4000

/** 超长时必须**仍是合法 JSON**。
 *
 *  早期版本直接 `slice` 字符串，结果吐给模型半截 JSON——它连"这是被截断的"
 *  都读不出来，只能瞎猜参数。现在退化成 `{truncated, note, preview}`：
 *  模型知道信息不全，也知道该缩小范围重试。 */
/** 字段级截断：单个长文本字段用。整体结果超长走 `wrap` 的降级路径。 */
function clip(text: string, limit: number): string {
  const flat = text.trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function cap(value: unknown): string {
  const text = JSON.stringify(value)
  if (text.length <= MAX_RESULT_CHARS) return text
  return JSON.stringify({
    truncated: true,
    note: `结果超过 ${MAX_RESULT_CHARS} 字，已只保留开头；请缩小范围再问。`,
    preview: text.slice(0, MAX_RESULT_CHARS),
  })
}

function wrap(value: unknown): ToolOutcome {
  return { ok: true, content: cap(value) }
}

function reject(message: string, extra?: Record<string, unknown>): ToolOutcome {
  return { ok: false, content: cap({ error: message, ...extra }) }
}

function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function readInt(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return null
}

function isSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warn' || value === 'info'
}

/** 评分卡在一次诊断内复用：24 次工具调用不该把规则跑 24 遍。
 *  规则包在整轮里不变，所以按会话 id 缓存就够。 */
function cardOf(context: ToolContext, session: SessionAnalysis): ScoreCard {
  const hit = context.cards?.get(session.id)
  if (hit) return hit
  const card = scoreSession(session, context.pack, context.annotations)
  context.cards?.set(session.id, card)
  return card
}

function findSession(context: ToolContext, id: string | null): SessionAnalysis | null {
  if (!id) return null
  return context.sessions.find((session) => session.id === id) ?? null
}

/** 找不到会话时把可用的 id 报回去——模型下一步就能自己纠正，
 *  比让它反复猜「是不是拼错了」省一整轮。 */
function unknownSession(context: ToolContext, id: string | null): ToolOutcome {
  return reject('没有这个会话 id', {
    given: id,
    available: context.sessions.slice(0, 20).map((session) => session.id),
  })
}

function findingView(finding: {
  ruleId: string
  severity: Severity
  dimension: string
  message: string
  stepIndex?: number
  evidence?: string
  impact: number
}) {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    dimension: finding.dimension,
    // 对外一律 1 基：与界面、报告、语义提示词同一个口径。
    step: finding.stepIndex === undefined ? null : finding.stepIndex + 1,
    message: finding.message,
    evidence: finding.evidence ?? null,
    impact: finding.impact,
  }
}

// ---------- 草稿包与试跑（simulate_pack 与 propose_pack 共用） ----------

type DraftResult =
  | { ok: true; pack: RulePack; applied: AppliedEdit[] }
  | { ok: false; outcome: ToolOutcome }

/** 把 edits 打到当前包的副本上，再交给契约校验。
 *
 *  校验是硬闸：模型可能写出语法合法但语义不对的表达式，`validatePack` 拦得住。
 *  两个工具共用这一份，避免「模拟能过、提案不过」这种自相矛盾。 */
function draftPack(context: ToolContext, edits: RuleEdit[]): DraftResult {
  const draft = structuredClone(context.pack)
  const missing: string[] = []
  for (const edit of edits) {
    const rule = draft.rules.find((item) => item.id === edit.ruleId)
    if (!rule) {
      missing.push(edit.ruleId)
      continue
    }
    if (edit.scoreImpact !== undefined) rule.scoreImpact = edit.scoreImpact
    if (edit.enabled !== undefined) rule.enabled = edit.enabled
    if (edit.severity !== undefined) rule.severity = edit.severity
    if (edit.expr !== undefined) rule.expr = edit.expr
  }
  if (missing.length > 0) {
    return {
      ok: false,
      outcome: reject('这些规则 id 不存在', {
        missing,
        // 给前 20 个 id 让模型自己纠正，省一整轮
        available: context.pack.rules.slice(0, 20).map((rule) => rule.id),
      }),
    }
  }

  const validation = validatePack(draft)
  if (!validation.ok) {
    return {
      ok: false,
      outcome: reject('草稿规则包未通过契约校验', {
        errors: formatPackErrors(validation.errors).slice(0, 6),
      }),
    }
  }

  // 「改完之后实际扣多少」由工具算：实测模型会拿 scoreImpact 当有效扣分，
  // 然后在结论里写一个编出来的数。
  const applied = edits
    .map((edit) => {
      const rule = validation.pack.rules.find((item) => item.id === edit.ruleId)
      if (!rule) return null
      return {
        ruleId: rule.id,
        severity: rule.severity,
        scoreImpact: rule.scoreImpact,
        effectiveImpact: Math.round(rule.scoreImpact * SEVERITY_FACTOR[rule.severity] * 10) / 10,
      }
    })
    .filter((item): item is AppliedEdit => item !== null)

  return { ok: true, pack: validation.pack, applied }
}

interface Simulation {
  rows: ProposalRow[]
  averageBefore: number
  averageAfter: number
  delta: number
  ruleIssues: { ruleId: string; message: string }[]
}

/** 真跑一遍草稿包。每条会话的「改后」卡片只算一次——既出分数又出规则异常，
 *  早先版本为这两件事各算了一遍。 */
function simulateOn(context: ToolContext, pack: RulePack): Simulation {
  const rows: ProposalRow[] = []
  const ruleIssues = new Map<string, string>()

  for (const session of context.sessions) {
    const before = cardOf(context, session)
    const after = buildCard(session.trajectory, session.metrics, pack, context.annotations)
    for (const issue of after.ruleIssues) ruleIssues.set(issue.ruleId, issue.message)
    rows.push({
      sessionId: session.id,
      label: session.trajectory.label,
      before: before.overall,
      after: after.overall,
      delta: after.overall - before.overall,
    })
  }

  const average = (pick: 'before' | 'after') =>
    rows.length === 0
      ? 0
      : Math.round((rows.reduce((sum, row) => sum + row[pick], 0) / rows.length) * 10) / 10
  const averageBefore = average('before')
  const averageAfter = average('after')

  return {
    rows,
    averageBefore,
    averageAfter,
    delta: Math.round((averageAfter - averageBefore) * 10) / 10,
    // 表达式出错不会让评分失败，只会让规则静默不生效——必须显式报出来。
    ruleIssues: [...ruleIssues].map(([ruleId, message]) => ({ ruleId, message })),
  }
}

const listSessions: Tool = {
  spec: {
    name: 'list_sessions',
    description:
      '列出所有会话的一句话概览：分数、等级、步数、token、问题计数。诊断的第一步通常是它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  run: (_args, context) => {
    if (context.sessions.length === 0) return reject('当前没有可分析的会话')
    return wrap({
      pack: {
        name: context.pack.name,
        version: context.pack.version,
        rules: context.pack.rules.length,
        enabled: context.pack.rules.filter((rule) => rule.enabled !== false).length,
        dimensions: context.pack.dimensions.map((dimension) => dimension.id),
      },
      sessions: context.sessions.map((session) => {
        const card = cardOf(context, session)
        return {
          id: session.id,
          label: session.trajectory.label,
          steps: session.trajectory.steps.length,
          tokens: session.metrics.totalTokens,
          tokensEstimated: session.trajectory.meta.estimatedTokens,
          overall: card.overall,
          capped: card.capped,
          grade: card.grade,
          counts: card.counts,
        }
      }),
    })
  },
}

const getCard: Tool = {
  spec: {
    name: 'get_card',
    description:
      '读取某条会话的完整评分卡：各维度得分与权重、错误封顶、问题计数、命中最多的问题、规则异常。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '会话 id（list_sessions 返回的那个）' } },
      required: ['sessionId'],
    },
  },
  run: (args, context) => {
    const session = findSession(context, readString(args, 'sessionId'))
    if (!session) return unknownSession(context, readString(args, 'sessionId'))
    const card = cardOf(context, session)
    return wrap({
      sessionId: session.id,
      label: session.trajectory.label,
      overall: card.overall,
      rawOverall: card.rawOverall,
      capped: card.capped,
      grade: card.grade,
      gradeLabel: card.gradeLabel,
      counts: card.counts,
      dimensions: card.dimensions.map((dimension) => ({
        id: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        score: dimension.score,
        lost: dimension.lost,
        findings: dimension.findings,
        errors: dimension.errors,
        warns: dimension.warns,
      })),
      topFindings: card.findings.slice(0, 12).map(findingView),
      ruleIssues: card.ruleIssues,
    })
  },
}

const getFindings: Tool = {
  spec: {
    name: 'get_findings',
    description:
      '按维度或严重度筛选某条会话的问题清单（ruleId、严重度、步号、证据、扣分）。想定位「哪些步出问题」时用它。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        dimension: { type: 'string', description: '维度 id，如 structure / execution / efficiency / semantic' },
        severity: { type: 'string', enum: ['error', 'warn', 'info'] },
        limit: { type: 'number', description: '最多返回多少条，默认 20，上限 50' },
      },
      required: ['sessionId'],
    },
  },
  run: (args, context) => {
    const session = findSession(context, readString(args, 'sessionId'))
    if (!session) return unknownSession(context, readString(args, 'sessionId'))
    const dimension = readString(args, 'dimension')
    const severity = args.severity
    const limit = Math.min(50, Math.max(1, readInt(args, 'limit') ?? 20))

    const card = cardOf(context, session)
    const filtered = card.findings.filter(
      (finding) =>
        (dimension === null || finding.dimension === dimension) &&
        (!isSeverity(severity) || finding.severity === severity),
    )
    return wrap({
      sessionId: session.id,
      total: filtered.length,
      returned: Math.min(limit, filtered.length),
      findings: filtered.slice(0, limit).map(findingView),
    })
  },
}

const readSteps: Tool = {
  spec: {
    name: 'read_steps',
    description:
      '按区间读步骤（1 基，含两端）：角色、文本、推理、工具调用与结果。默认 10 步，一次最多 40 步；长轨迹只读你要判断的那一段。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        from: { type: 'number', description: '起始步号（1 基），默认 1' },
        to: { type: 'number', description: '结束步号（1 基，含），默认 from+9' },
      },
      required: ['sessionId'],
    },
  },
  run: (args, context) => {
    const session = findSession(context, readString(args, 'sessionId'))
    if (!session) return unknownSession(context, readString(args, 'sessionId'))
    const steps = session.trajectory.steps
    const from = Math.max(1, readInt(args, 'from') ?? 1)
    const to = readInt(args, 'to') ?? from + 9
    if (to < from) return reject('to 不能小于 from', { from, to })
    if (to - from + 1 > 40) return reject('一次最多读 40 步，请缩小区间', { from, to })

    const slice = steps.slice(from - 1, Math.min(to, steps.length))
    if (slice.length === 0) return reject('区间超出范围', { steps: steps.length, from, to })
    return wrap({
      sessionId: session.id,
      steps: steps.length,
      from,
      to: from + slice.length - 1,
      content: slice.map((step) => renderStep(step, DIGEST_DEFAULTS)).join('\n'),
    })
  },
}

const getStep: Tool = {
  spec: {
    name: 'get_step',
    description: '读单步详情（1 基）：完整文本、推理、每个工具调用的参数与结果、该步命中的问题。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, step: { type: 'number', description: '步号，1 基' } },
      required: ['sessionId', 'step'],
    },
  },
  run: (args, context) => {
    const session = findSession(context, readString(args, 'sessionId'))
    if (!session) return unknownSession(context, readString(args, 'sessionId'))
    const stepNo = readInt(args, 'step')
    if (stepNo === null) return reject('需要 step（1 基步号）')
    const step = session.trajectory.steps[stepNo - 1]
    if (!step) return reject('步号超出范围', { steps: session.trajectory.steps.length, given: stepNo })

    const card = cardOf(context, session)
    return wrap({
      sessionId: session.id,
      step: stepNo,
      role: step.role,
      text: clip(step.text, 1500),
      reasoning: clip(step.reasoning, 600),
      tokens: step.tokens,
      toolCalls: step.toolCalls.map((call) => ({
        name: call.name,
        args: clip(call.rawArgs, 400),
        argsValid: call.argsValid,
        result: call.result
          ? { isError: call.result.isError, content: clip(call.result.content, 600) }
          : null,
      })),
      result: step.result
        ? { isError: step.result.isError, content: clip(step.result.content, 800) }
        : null,
      findings: card.findings.filter((finding) => finding.stepIndex === stepNo - 1).map(findingView),
    })
  },
}

function searchable(step: Step): string {
  const parts = [step.text, step.reasoning]
  for (const call of step.toolCalls) {
    parts.push(call.name, call.rawArgs, call.result?.content ?? '')
  }
  if (step.result?.content) parts.push(step.result.content)
  return parts.join('\n')
}

const searchSteps: Tool = {
  spec: {
    name: 'search_steps',
    description:
      '在一条会话里按关键字检索步骤（大小写不敏感的子串匹配），返回命中的步号与上下文片段。找「哪一步出现了某个错误/某个工具」时比逐段读快。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        query: { type: 'string', description: '要查找的字符串' },
        limit: { type: 'number', description: '最多返回多少处，默认 10，上限 30' },
      },
      required: ['sessionId', 'query'],
    },
  },
  run: (args, context) => {
    const session = findSession(context, readString(args, 'sessionId'))
    if (!session) return unknownSession(context, readString(args, 'sessionId'))
    const query = readString(args, 'query')
    if (!query) return reject('需要 query')
    const limit = Math.min(30, Math.max(1, readInt(args, 'limit') ?? 10))

    const needle = query.toLowerCase()
    const hits: { step: number; role: string; snippet: string }[] = []
    for (const step of session.trajectory.steps) {
      if (hits.length >= limit) break
      const haystack = searchable(step)
      const at = haystack.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const start = Math.max(0, at - 60)
      hits.push({
        step: step.index + 1,
        role: step.role,
        snippet: haystack.slice(start, at + query.length + 60).replace(/\s+/g, ' ').trim(),
      })
    }
    return wrap({ sessionId: session.id, query, hits, truncated: hits.length >= limit })
  },
}

const listRules: Tool = {
  spec: {
    name: 'list_rules',
    description:
      '列出当前规则包里的规则清单（id、维度、严重度、扣分、启用状态）。要某条规则的表达式用 tune_literal。',
    parameters: {
      type: 'object',
      properties: { dimension: { type: 'string', description: '只看某个维度' } },
      required: [],
    },
  },
  run: (args, context) => {
    const dimension = readString(args, 'dimension')
    const rules = context.pack.rules
      .filter((rule) => dimension === null || rule.dimension === dimension)
      .map((rule) => ({
        id: rule.id,
        dimension: rule.dimension,
        severity: rule.severity,
        scoreImpact: rule.scoreImpact,
        enabled: rule.enabled !== false,
      }))
    if (rules.length === 0) return reject('这个维度下没有规则', { dimension })
    // 这里刻意不带 expr / title：24 条规则带上表达式必超长度上限，
    // 结果被截断后模型反而看不到完整清单，白白多烧一轮。要看表达式走 tune_literal。
    return wrap({ pack: context.pack.name, total: rules.length, rules })
  },
}

/** 数值参数。规格里 `scoreImpact` 声明的是 number，规则包本身也允许小数（0–100），
 *  所以这里不能像 `readInt` 那样只收整数。模型有时把数字写成字符串，也收。 */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return null
}

type EditsRead = { ok: true; edits: RuleEdit[] } | { ok: false; error: string }

/** 把工具参数读成规则改动。**写错了就报错，不丢弃。**
 *
 *  此前不认的字段（小数的 scoreImpact、拼错的 severity、字符串形式的 enabled）被悄悄忽略，
 *  `draftPack` 什么也没改、`validatePack` 当然通过，于是 simulate_pack 返回 valid:true、delta:0，
 *  模型据此写出「这条改动没有影响」——一个由我们的静默丢弃造出来的、看似有数字支撑的错误结论。 */
function readEdits(args: Record<string, unknown>): EditsRead {
  const raw = args.edits
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: '需要非空的 edits 数组，每项至少含 ruleId' }
  }
  const edits: RuleEdit[] = []
  for (const [index, item] of raw.entries()) {
    const where = `edits[${index}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `${where} 必须是对象` }
    }
    const record = item as Record<string, unknown>
    const ruleId = readString(record, 'ruleId')
    if (!ruleId) return { ok: false, error: `${where}.ruleId 缺失或不是非空字符串` }
    const edit: RuleEdit = { ruleId }

    // null 与缺省等价：模型常把没打算改的字段显式写成 null。
    const given = (key: string) => record[key] !== undefined && record[key] !== null

    if (given('scoreImpact')) {
      const impact = readNumber(record.scoreImpact)
      if (impact === null) return { ok: false, error: `${where}.scoreImpact 必须是数字，收到 ${JSON.stringify(record.scoreImpact)}` }
      edit.scoreImpact = impact
    }
    if (given('enabled')) {
      if (typeof record.enabled !== 'boolean') {
        return { ok: false, error: `${where}.enabled 必须是 true 或 false（布尔值），收到 ${JSON.stringify(record.enabled)}` }
      }
      edit.enabled = record.enabled
    }
    if (given('severity')) {
      if (!isSeverity(record.severity)) {
        return { ok: false, error: `${where}.severity 只能是 error / warn / info，收到 ${JSON.stringify(record.severity)}` }
      }
      edit.severity = record.severity
    }
    if (given('expr')) {
      const expr = readString(record, 'expr')
      if (!expr) return { ok: false, error: `${where}.expr 必须是非空字符串` }
      edit.expr = expr
    }
    edits.push(edit)
  }
  return { ok: true, edits }
}

const simulatePack: Tool = {
  spec: {
    name: 'simulate_pack',
    description:
      '在草稿规则包上真跑一遍全部会话，返回平均分与逐会话变化。用于验证「改这条规则会怎样」——只算，不改当前规则包。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '要改的规则字段',
          items: {
            type: 'object',
            properties: {
              ruleId: { type: 'string' },
              scoreImpact: { type: 'number', description: '扣分力度' },
              enabled: { type: 'boolean' },
              severity: { type: 'string', enum: ['error', 'warn', 'info'] },
              expr: { type: 'string', description: '新的判定表达式' },
            },
            required: ['ruleId'],
          },
        },
      },
      required: ['edits'],
    },
  },
  run: (args, context) => {
    const read = readEdits(args)
    if (!read.ok) return reject(read.error)
    const edits = read.edits

    const draft = draftPack(context, edits)
    if (!draft.ok) return draft.outcome
    const simulation = simulateOn(context, draft.pack)

    return wrap({
      valid: true,
      applied: draft.applied,
      averageBefore: simulation.averageBefore,
      averageAfter: simulation.averageAfter,
      delta: simulation.delta,
      ruleIssues: simulation.ruleIssues,
      rows: simulation.rows,
    })
  },
}

const proposePack: Tool = {
  spec: {
    name: 'propose_pack',
    description:
      '提交一份规则包提案（**不会生效**，要不要采用由人决定）。给出 edits 与理由，工具会自动试跑并记下改前/改后的平均分。只有你确实认为规则口径该调整时才用；多数情况下「不用改」才是正解。',
    parameters: {
      type: 'object',
      properties: {
        rationale: { type: 'string', description: '为什么该这么改，一句话' },
        edits: {
          type: 'array',
          description: '要改的规则字段',
          items: {
            type: 'object',
            properties: {
              ruleId: { type: 'string' },
              scoreImpact: { type: 'number' },
              enabled: { type: 'boolean' },
              severity: { type: 'string', enum: ['error', 'warn', 'info'] },
              expr: { type: 'string' },
            },
            required: ['ruleId'],
          },
        },
      },
      required: ['rationale', 'edits'],
    },
  },
  run: (args, context) => {
    const read = readEdits(args)
    if (!read.ok) return reject(read.error)
    const edits = read.edits
    const rationale = readString(args, 'rationale')
    if (!rationale) return reject('需要 rationale：一句话说明为什么该这么改')

    const draft = draftPack(context, edits)
    if (!draft.ok) return draft.outcome

    const index = (context.proposals?.length ?? 0) + 1
    const named: RulePack = { ...draft.pack, name: `${context.pack.name} · 提案 ${index}` }
    const simulation = simulateOn(context, named)

    const proposal: PackProposal = {
      id: `p${index}`,
      rationale,
      edits,
      applied: draft.applied,
      // 存完整包：CLI 直接写成文件就能当 --pack 用，不必再由人拼一遍。
      pack: named,
      averageBefore: simulation.averageBefore,
      averageAfter: simulation.averageAfter,
      delta: simulation.delta,
      rows: simulation.rows,
    }
    context.proposals?.push(proposal)

    return wrap({
      accepted: true,
      id: proposal.id,
      // 明确指出「还没生效」：模型据此在结论里不要说「已修复」。
      appliedToWorkspace: false,
      averageBefore: proposal.averageBefore,
      averageAfter: proposal.averageAfter,
      delta: proposal.delta,
      ruleIssues: simulation.ruleIssues,
    })
  },
}

const tuneLiteral: Tool = {
  spec: {
    name: 'tune_literal',
    description:
      '列出某条规则表达式里的数字常量，或把其中一个替换成新值并检查是否仍能编译。想调阈值时先用它验证可行性，再交给 simulate_pack 试跑。',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string' },
        index: { type: 'number', description: '第几个数字常量（0 基）；不传则只列出' },
        next: { type: 'number', description: '替换成什么值' },
      },
      required: ['ruleId'],
    },
  },
  run: (args, context) => {
    const ruleId = readString(args, 'ruleId')
    const rule = context.pack.rules.find((item) => item.id === ruleId)
    if (!rule) {
      return reject('没有这条规则', {
        given: ruleId,
        available: context.pack.rules.slice(0, 20).map((item) => item.id),
      })
    }
    const literals = numericLiterals(rule.expr)
    const index = readInt(args, 'index')
    if (index === null) return wrap({ ruleId, expr: rule.expr, literals })

    const next = readInt(args, 'next')
    if (next === null) return reject('需要 next（新数值）')
    const replaced = replaceLiteral(rule.expr, index, next)
    if (replaced === null) {
      // 这是本工具存在的意义：替换后编译不过，就别拿去试跑。
      return reject('替换后表达式无法编译，换个位置或换种改法', {
        expr: rule.expr,
        index,
        next,
        literals,
      })
    }
    return wrap({ ruleId, before: rule.expr, after: replaced, index, next, literals })
  },
}

const compareSessionsTool: Tool = {
  spec: {
    name: 'compare_sessions',
    description: '对比两条会话：分数与维度增量、问题新增/修复/仍在。用于「同一任务两个版本哪个更好」。',
    parameters: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: '基准会话 id' },
        targetId: { type: 'string', description: '对照会话 id' },
      },
      required: ['baseId', 'targetId'],
    },
  },
  run: (args, context) => {
    const base = findSession(context, readString(args, 'baseId'))
    if (!base) return unknownSession(context, readString(args, 'baseId'))
    const target = findSession(context, readString(args, 'targetId'))
    if (!target) return unknownSession(context, readString(args, 'targetId'))
    if (base.id === target.id) return reject('基准与对照不能是同一条会话')

    const baseCard = cardOf(context, base)
    const targetCard = cardOf(context, target)
    const diff = compareCards(
      { card: baseCard, trajectory: base.trajectory },
      { card: targetCard, trajectory: target.trajectory },
    )
    const findings = diffFindings(baseCard.findings, targetCard.findings)
    return wrap({
      base: { id: base.id, label: base.trajectory.label },
      target: { id: target.id, label: target.trajectory.label },
      overall: diff.overall,
      grade: diff.grade,
      dimensions: diff.dimensions,
      counts: diff.counts,
      steps: diff.steps,
      tokens: diff.tokens,
      added: findings.added.slice(0, 8).map(findingView),
      resolved: findings.resolved.slice(0, 8).map(findingView),
      persisted: findings.persisted.length,
      netChange: findings.netChange,
    })
  },
}

/** 诊断结论的入参校验：模型给什么都不奇怪，落地前必须逐字段确认。 */
export function parseDiagnosis(args: Record<string, unknown>): Diagnosis | null {
  const verdict = readString(args, 'verdict')
  if (!verdict) return null

  const rootCauses: Diagnosis['rootCauses'] = []
  if (Array.isArray(args.rootCauses)) {
    for (const item of args.rootCauses) {
      const record = item as Record<string, unknown>
      const cause = readString(record, 'cause')
      if (!cause) continue
      rootCauses.push({
        session: readString(record, 'session') ?? undefined,
        cause,
        evidence: readString(record, 'evidence') ?? '',
      })
      if (rootCauses.length >= 8) break
    }
  }

  const actions: Diagnosis['actions'] = []
  if (Array.isArray(args.actions)) {
    for (const item of args.actions) {
      const record = item as Record<string, unknown>
      const action = readString(record, 'action')
      if (!action) continue
      actions.push({
        action,
        rationale: readString(record, 'rationale') ?? '',
        ruleId: readString(record, 'ruleId') ?? undefined,
      })
      if (actions.length >= 8) break
    }
  }

  return { verdict, rootCauses, actions }
}

const submitDiagnosis: Tool = {
  spec: {
    name: 'submit_diagnosis',
    description:
      '提交最终诊断并结束。调用它之后循环立即停止。verdict 给结论，rootCauses 给根因（附证据），actions 给可执行动作。',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', description: '两三句话的总体结论' },
        rootCauses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              session: { type: 'string', description: '会话 id；跨会话共性问题可省略' },
              cause: { type: 'string' },
              evidence: { type: 'string', description: '证据：具体步号或某次工具返回值' },
            },
            required: ['cause'],
          },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: '可执行动作，一句话' },
              rationale: { type: 'string' },
              ruleId: { type: 'string', description: '涉及规则时给出 id' },
            },
            required: ['action'],
          },
        },
      },
      required: ['verdict'],
    },
  },
  terminal: true,
  run: (args) => {
    const diagnosis = parseDiagnosis(args)
    if (!diagnosis) return reject('verdict 不能为空')
    return { ok: true, content: JSON.stringify({ accepted: true }) }
  },
}

export const TOOLS: Tool[] = [
  listSessions,
  getCard,
  getFindings,
  readSteps,
  getStep,
  searchSteps,
  listRules,
  simulatePack,
  tuneLiteral,
  compareSessionsTool,
  // 提案排在终结工具之前：模型先算、再提议、最后收尾，顺序与它的调用习惯一致。
  proposePack,
  submitDiagnosis,
]

export const TERMINAL_TOOL = submitDiagnosis.spec.name

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.spec.name === name)
}

export function toolSpecs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return TOOLS.map((tool) => tool.spec)
}
