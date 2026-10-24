/** 两条轨迹的差异：分数、问题、步骤对齐。
 *
 *  对齐只按「结构」——角色 + 工具名序列；内容是否变化另算。原因很实际：
 *  改 prompt 后每条助手文本都会变，若把文本也塞进签名，整条轨迹会变成
 *  「全部删除 + 全部新增」，对比就没有意义了。
 *
 *  LCS 是 O(n·m)；超上限时退化为按位置配对，并如实标出来（不假装对齐过）。
 */

import type { Finding, Severity, Step, Trajectory } from './model'
import type { ScoreCard } from './analysis/score'

export interface Delta {
  before: number
  after: number
  /** after - before，正数表示变多/变好（由调用方按语义解释）。 */
  delta: number
}

export interface DimensionDelta extends Delta {
  id: string
  label: string
}

export interface CardDiff {
  overall: Delta
  grade: { before: string; after: string }
  dimensions: DimensionDelta[]
  counts: { severity: Severity; before: number; after: number; delta: number }[]
  steps: Delta
  tokens: Delta
}

export interface FindingDiff {
  added: Finding[]
  resolved: Finding[]
  persisted: Finding[]
  /** `persisted` 里文案变了的那几条（比如重复次数 9 → 12）：同一个问题，只是程度变了。 */
  changed: { before: Finding; after: Finding }[]
  /** 新增数 - 修复数。 */
  netChange: number
}

export type AlignStatus = 'same' | 'changed' | 'added' | 'removed'

export interface AlignedStep {
  status: AlignStatus
  before?: Step
  after?: Step
}

export interface CompareSide {
  card: ScoreCard
  trajectory: Trajectory
}

const SEVERITIES: Severity[] = ['error', 'warn', 'info']

export function compareCards(before: CompareSide, after: CompareSide): CardDiff {
  const beforeDimensions = new Map(before.card.dimensions.map((dimension) => [dimension.id, dimension]))

  const dimensions: DimensionDelta[] = after.card.dimensions.map((dimension) => {
    const previous = beforeDimensions.get(dimension.id)
    const beforeScore = previous?.score ?? 0
    return {
      id: dimension.id,
      label: previous?.label ?? dimension.label,
      before: beforeScore,
      after: dimension.score,
      delta: dimension.score - beforeScore,
    }
  })

  return {
    overall: {
      before: before.card.overall,
      after: after.card.overall,
      delta: after.card.overall - before.card.overall,
    },
    grade: { before: before.card.grade, after: after.card.grade },
    dimensions,
    counts: SEVERITIES.map((severity) => ({
      severity,
      before: before.card.counts[severity],
      after: after.card.counts[severity],
      delta: after.card.counts[severity] - before.card.counts[severity],
    })),
    steps: {
      before: before.trajectory.steps.length,
      after: after.trajectory.steps.length,
      delta: after.trajectory.steps.length - before.trajectory.steps.length,
    },
    tokens: {
      before: before.trajectory.meta.totalTokens,
      after: after.trajectory.meta.totalTokens,
      delta: after.trajectory.meta.totalTokens - before.trajectory.meta.totalTokens,
    },
  }
}

/** 基准的步号 → 对照里与它配对的那一步的步号。只有两边都在的行才有映射：
 *  被删掉的步、新增的步都没有。大轨迹退化成按位置配对时，行里照样是成对的，这里照样成立。 */
function stepMapping(rows: AlignedStep[]): Map<number, number> {
  const mapping = new Map<number, number>()
  for (const row of rows) {
    if (row.before && row.after) mapping.set(row.before.index, row.after.index)
  }
  return mapping
}

/** 一条问题在「对照的坐标系」里的身份：规则 + 步。
 *
 *  不含消息文案：文案里嵌着步号和计数（「第 7 步…」「连续 9 次」），步号一挪、计数一变，
 *  键就变了，同一个问题被当成「一条消失、一条出现」。文案变了另外记（见 `changed`）。
 *
 *  `mapped` 为 undefined 表示没有对齐信息，直接用原始步号；为 null 表示这条问题所在的步
 *  在对照里没有配对（被删了），给一个绝不会和对照侧撞上的键——它不是「还在」，是随那一步一起没了。 */
function identity(finding: Finding, mapped: number | null | undefined): string {
  if (finding.stepIndex === undefined) return `${finding.ruleId}#trajectory`
  if (mapped === null) return `${finding.ruleId}#removed:${finding.stepIndex}`
  return `${finding.ruleId}#${mapped ?? finding.stepIndex}`
}

/** 把文案里「这条问题自己的步号」抹掉再比较。插入一步后「第 4 步没有结果」变成「第 5 步没有结果」，
 *  问题没变，只是步号跟着挪了，不该算文案变化；而「连续 9 次」→「连续 12 次」是真的变了。
 *  这是启发式：计数恰好等于步号时会被一并抹掉，代价只是少标一个「变化」，不会影响增删判定。 */
function textWithoutOwnStep(finding: Finding): string {
  if (finding.stepIndex === undefined) return finding.message
  const own = String(finding.stepIndex + 1)
  return finding.message.replace(new RegExp(`(?<!\\d)${own}(?!\\d)`, 'g'), '#')
}

/** 两条轨迹的问题变化。
 *
 *  传入 `rows`（`alignSteps` 的结果）时，基准的步号先按对齐换算到对照的步号再认同一条问题：
 *  改 prompt 后中间多出一步，后面所有逐步问题的步号都 +1，不换算的话每一条都会显示成
 *  「已修复 + 新增」，净变化为 0，却列出一长串假的增删。
 *  不传就按原始步号比，行为与从前一致。 */
export function diffFindings(before: Finding[], after: Finding[], rows?: AlignedStep[]): FindingDiff {
  const mapping = rows ? stepMapping(rows) : undefined
  const beforeIdentity = (finding: Finding): string => {
    if (!mapping || finding.stepIndex === undefined) return identity(finding, undefined)
    return identity(finding, mapping.get(finding.stepIndex) ?? null)
  }

  const beforeByKey = new Map<string, Finding>()
  for (const finding of before) beforeByKey.set(beforeIdentity(finding), finding)
  const afterByKey = new Map<string, Finding>()
  for (const finding of after) afterByKey.set(identity(finding, undefined), finding)

  const added = after.filter((finding) => !beforeByKey.has(identity(finding, undefined)))
  const resolved = before.filter((finding) => !afterByKey.has(beforeIdentity(finding)))
  const persisted = after.filter((finding) => beforeByKey.has(identity(finding, undefined)))

  const changed = persisted.flatMap((finding) => {
    const previous = beforeByKey.get(identity(finding, undefined))
    return previous && textWithoutOwnStep(previous) !== textWithoutOwnStep(finding)
      ? [{ before: previous, after: finding }]
      : []
  })

  return { added, resolved, persisted, changed, netChange: added.length - resolved.length }
}

/** 结构签名：角色 + 工具名。文本变化不算结构变化。 */
export function stepSignature(step: Step): string {
  return `${step.role}|${step.toolCalls.map((call) => call.name).join(',')}`
}

/** FNV-1a：先把内容压成 32 位指纹，避免 LCS 里做 O(n·m) 次长字符串比较。 */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

function contentSignature(step: Step): string {
  return [
    hash(step.text),
    hash(step.reasoning),
    hash(step.result?.content ?? ''),
    hash(step.toolCalls.map((call) => `${call.name}:${call.rawArgs}`).join('|')),
  ].join(':')
}

export const ALIGN_CELL_LIMIT = 400_000

/** 按结构做 LCS 对齐；返回按出现顺序排列的差异序列。 */
export function alignSteps(before: Step[], after: Step[], cellLimit = ALIGN_CELL_LIMIT): AlignedStep[] {
  const n = before.length
  const m = after.length
  if (n === 0 && m === 0) return []
  if (n === 0) return after.map((step) => ({ status: 'added' as const, after: step }))
  if (m === 0) return before.map((step) => ({ status: 'removed' as const, before: step }))

  const tooLarge = (n + 1) * (m + 1) > cellLimit
  if (tooLarge) {
    // 大轨迹不强行对齐：按位置配对，长短差异如实呈现（多出来的算增删）。
    const rows: AlignedStep[] = []
    for (let index = 0; index < Math.max(n, m); index += 1) {
      const beforeStep = before[index]
      const afterStep = after[index]
      if (beforeStep && afterStep) {
        const same =
          stepSignature(beforeStep) === stepSignature(afterStep) &&
          contentSignature(beforeStep) === contentSignature(afterStep)
        rows.push({ status: same ? 'same' : 'changed', before: beforeStep, after: afterStep })
      } else if (beforeStep) rows.push({ status: 'removed', before: beforeStep })
      else if (afterStep) rows.push({ status: 'added', after: afterStep })
    }
    return rows
  }

  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  const beforeSignatures = before.map(stepSignature)
  const afterSignatures = after.map(stepSignature)

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const here = i * width + j
      table[here] =
        beforeSignatures[i] === afterSignatures[j]
          ? (table[(i + 1) * width + (j + 1)] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + (j + 1)] as number)
    }
  }

  const rows: AlignedStep[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeSignatures[i] === afterSignatures[j]) {
      const same = contentSignature(before[i] as Step) === contentSignature(after[j] as Step)
      rows.push({
        status: same ? 'same' : 'changed',
        before: before[i] as Step,
        after: after[j] as Step,
      })
      i += 1
      j += 1
      continue
    }
    const skipBefore = table[(i + 1) * width + j] as number
    const skipAfter = table[i * width + (j + 1)] as number
    if (skipBefore >= skipAfter) {
      rows.push({ status: 'removed', before: before[i] as Step })
      i += 1
    } else {
      rows.push({ status: 'added', after: after[j] as Step })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ status: 'removed', before: before[i] as Step })
    i += 1
  }
  while (j < m) {
    rows.push({ status: 'added', after: after[j] as Step })
    j += 1
  }

  return rows
}

export interface AlignSummary {
  total: number
  same: number
  changed: number
  added: number
  removed: number
}

export function summarizeAlignment(rows: AlignedStep[]): AlignSummary {
  const summary: AlignSummary = { total: rows.length, same: 0, changed: 0, added: 0, removed: 0 }
  for (const row of rows) summary[row.status] += 1
  return summary
}
