/** 规则调参：把「改阈值」变成可试算的动作。
 *
 *  两个纯函数族：
 *  1. 表达式里的数字字面量——能被识别、能被原位替换，**替换后必须仍能编译**，
 *     否则返回 null。不做正则盲替换，免得把 `role == "gpt4"` 里的 4 改坏。
 *  2. 试跑统计——给定若干轨迹与一份草稿包，算出每条规则命中多少、影响多少分。
 *     「禁用这条规则会扣回多少分」用同一套评分函数重算，不另写一份公式。
 */

import { compileExpression } from './expr'
import type { Finding, RulePack, Trajectory } from '../model'
import { computeMetrics } from '../analysis/metrics'
import { runRules } from './engine'
import { scoreTrajectory } from '../analysis/score'

export interface NumericLiteral {
  /** 在表达式里是第几个字面量（从 0 起）。 */
  index: number
  value: number
  /** 原始写法（保留 `0.30` 这类形态，避免改写精度）。 */
  text: string
  start: number
  end: number
}

/** 跳过字符串字面量与标识符中的数字，只认真正的数字常量。 */
export function numericLiterals(expr: string): NumericLiteral[] {
  const literals: NumericLiteral[] = []
  let index = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i] as string

    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    const isDigit = char >= '0' && char <= '9'
    const startsNumber = isDigit && (i === 0 || !/[A-Za-z0-9_.]/.test(expr[i - 1] as string))
    if (!startsNumber) continue

    let end = i
    while (end + 1 < expr.length && /[0-9.]/.test(expr[end + 1] as string)) end += 1
    // 数字后紧跟标识符字符（1e5、2px）时不当作可调字面量，避免引入无效语法。
    const trailing = expr[end + 1]
    if (trailing !== undefined && /[A-Za-z_]/.test(trailing)) {
      i = end
      continue
    }

    const text = expr.slice(i, end + 1)
    const value = Number(text)
    if (Number.isFinite(value)) {
      literals.push({ index, value, text, start: i, end: end + 1 })
      index += 1
    }
    i = end
  }

  return literals
}

/** 替换第 `index` 个字面量；替换后无法编译则返回 null（调用方据此保持原值）。 */
export function replaceLiteral(expr: string, index: number, next: number): string | null {
  if (!Number.isFinite(next)) return null
  const literal = numericLiterals(expr)[index]
  if (!literal) return null

  const replacement = String(next)
  const candidate = expr.slice(0, literal.start) + replacement + expr.slice(literal.end)

  try {
    compileExpression(candidate)
  } catch {
    return null
  }
  return candidate
}

export interface TuningSession {
  id: string
  trajectory: Trajectory
}

export interface RuleStat {
  ruleId: string
  hits: number
  /** 有命中的轨迹数。 */
  sessions: number
  /** 禁用该规则后，各轨迹总分的平均提升（0 表示没有影响）。 */
  avgGain: number
  /** 单条轨迹上的最大提升，用来排序「最该先调哪条」。 */
  maxGain: number
  /** 该规则当前是否参与评分。 */
  enabled: boolean
}

export interface TuningReport {
  rules: RuleStat[]
  /** 草稿包下每轨迹的总分（按输入顺序）。 */
  scores: { id: string; score: number }[]
  average: number
  totalHits: number
  /** 草稿包里因表达式错误被跳过的规则。 */
  brokenRules: { ruleId: string; message: string }[]
}

/** 用草稿包把每条轨迹重跑一遍，并逐规则试算「禁用后的分数」。 */
export function buildTuningReport(sessions: TuningSession[], pack: RulePack): TuningReport {
  const perRule = new Map<string, { hits: number; sessions: number; gains: number[]; enabled: boolean }>()
  for (const rule of pack.rules) {
    perRule.set(rule.id, { hits: 0, sessions: 0, gains: [], enabled: rule.enabled !== false })
  }

  const scores: { id: string; score: number }[] = []
  const brokenRules = new Map<string, string>()

  for (const session of sessions) {
    const metrics = computeMetrics(session.trajectory)
    const { findings, ruleIssues } = runRules(session.trajectory, pack, metrics)
    for (const issue of ruleIssues) brokenRules.set(issue.ruleId, issue.message)

    const card = scoreTrajectory(findings, pack.dimensions, ruleIssues)
    scores.push({ id: session.id, score: card.overall })

    const hitsByRule = new Map<string, number>()
    for (const finding of findings) {
      if (finding.ruleId === 'manual') continue
      hitsByRule.set(finding.ruleId, (hitsByRule.get(finding.ruleId) ?? 0) + 1)
    }

    for (const [ruleId, count] of hitsByRule) {
      const entry = perRule.get(ruleId)
      if (!entry) continue
      entry.hits += count
      entry.sessions += 1
      const without: Finding[] = findings.filter((finding) => finding.ruleId !== ruleId)
      const gain = scoreTrajectory(without, pack.dimensions, ruleIssues).overall - card.overall
      entry.gains.push(gain)
    }
  }

  const rules: RuleStat[] = pack.rules.map((rule) => {
    const entry = perRule.get(rule.id)
    const gains = entry?.gains ?? []
    return {
      ruleId: rule.id,
      hits: entry?.hits ?? 0,
      sessions: entry?.sessions ?? 0,
      avgGain: gains.length > 0 ? Math.round(gains.reduce((sum, gain) => sum + gain, 0) / gains.length) : 0,
      maxGain: gains.length > 0 ? Math.max(...gains) : 0,
      enabled: rule.enabled !== false,
    }
  })

  return {
    rules,
    scores,
    average:
      scores.length > 0 ? Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length) : 100,
    totalHits: rules.reduce((sum, rule) => sum + rule.hits, 0),
    brokenRules: [...brokenRules.entries()].map(([ruleId, message]) => ({ ruleId, message })),
  }
}
