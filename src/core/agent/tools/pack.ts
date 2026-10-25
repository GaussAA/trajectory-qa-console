/** 规则包类工具：列规则、调阈值、在草稿包上试跑、提交提案。
 *
 *  simulate_pack 与 propose_pack 共用 draftPack / simulateOn，
 *  避免「模拟能过、提案不过」这种自相矛盾。 */

import { buildCard } from '../../analysis'
import { SEVERITY_FACTOR, type RulePack } from '../../model'
import { formatPackErrors, validatePack } from '../../rules/contract'
import { numericLiterals, replaceLiteral } from '../../rules/tuning'
import type {
  AppliedEdit,
  PackProposal,
  ProposalRow,
  RuleEdit,
  Tool,
  ToolContext,
  ToolOutcome,
} from '../types'
import { cardOf, isSeverity, readInt, readString, reject, wrap } from './shared'

// ---------- 草稿包与试跑（simulate_pack 与 propose_pack 共用） ----------

type DraftResult = { ok: true; pack: RulePack; applied: AppliedEdit[] } | { ok: false; outcome: ToolOutcome }

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

export const listRules: Tool = {
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
      if (impact === null)
        return {
          ok: false,
          error: `${where}.scoreImpact 必须是数字，收到 ${JSON.stringify(record.scoreImpact)}`,
        }
      edit.scoreImpact = impact
    }
    if (given('enabled')) {
      if (typeof record.enabled !== 'boolean') {
        return {
          ok: false,
          error: `${where}.enabled 必须是 true 或 false（布尔值），收到 ${JSON.stringify(record.enabled)}`,
        }
      }
      edit.enabled = record.enabled
    }
    if (given('severity')) {
      if (!isSeverity(record.severity)) {
        return {
          ok: false,
          error: `${where}.severity 只能是 error / warn / info，收到 ${JSON.stringify(record.severity)}`,
        }
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

export const simulatePack: Tool = {
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

export const proposePack: Tool = {
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

export const tuneLiteral: Tool = {
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
