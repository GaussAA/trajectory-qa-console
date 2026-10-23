/** 口径对比：两个规则包跑同一批轨迹，分数并排。
 *
 *  与调参、CLI 同一条边界：只算规则与维度，不含人工标注（标注属于工作区，
 *  依赖会话 id；而这里同一批轨迹要在两套口径下各跑一遍）。
 */

import type { ScoreCard } from './analysis'
import { scoreTrajectory } from './analysis/score'
import type { RulePack, Trajectory } from './model'
import { runRules } from './rules/engine'

/** 只要轨迹本体：调参面板传的是轻量会话（id + trajectory），也能直接用。 */
export interface PackCompareSession {
  id: string
  trajectory: Trajectory
}

export interface PackOption {
  id: string
  name: string
  pack: RulePack
}

export interface PackSessionScore {
  sessionId: string
  label: string
  base: number
  target: number
  delta: number
}

export interface PackComparison {
  rows: PackSessionScore[]
  baseAverage: number
  targetAverage: number
  /** 两份口径内容相同（JSON 串相等）：没有可比的差异，界面应如实说明。 */
  identical: boolean
}

/** 单条会话在指定口径下的得分：真跑规则，不估算。 */
export function scoreUnderPack(session: PackCompareSession, pack: RulePack): ScoreCard {
  const { findings, ruleIssues } = runRules(session.trajectory, pack)
  return scoreTrajectory(findings, pack.dimensions, ruleIssues)
}

export function comparePacks(
  sessions: PackCompareSession[],
  basePack: RulePack,
  targetPack: RulePack,
): PackComparison {
  const rows = sessions.map((session) => {
    const base = scoreUnderPack(session, basePack).overall
    const target = scoreUnderPack(session, targetPack).overall
    return { sessionId: session.id, label: session.trajectory.label, base, target, delta: target - base }
  })

  const averageOf = (pick: 'base' | 'target') =>
    rows.length > 0 ? Math.round(rows.reduce((sum, row) => sum + row[pick], 0) / rows.length) : 100

  return {
    rows,
    baseAverage: averageOf('base'),
    targetAverage: averageOf('target'),
    identical: JSON.stringify(basePack) === JSON.stringify(targetPack),
  }
}
