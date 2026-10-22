import type { RulePack } from '../core/rules'
import type { ScoreCard } from '../core/score'
import type { Trajectory } from '../core/types'
import { formatTokens } from '../core/estimate'
import { SEVERITY_COLOR } from './format'

const SEVERITY_TEXT: Record<string, string> = { error: '严重', warn: '警告', info: '提示' }

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

export function buildMarkdownReport(input: {
  trajectories: Trajectory[]
  cards: Map<string, ScoreCard>
  pack: RulePack
  generatedAt: Date
}): string {
  const { trajectories, cards, pack, generatedAt } = input
  const lines: string[] = []

  lines.push('# 轨迹质检报告')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt.toLocaleString('zh-CN')}`)
  lines.push(`- 规则包：${pack.name}（${pack.rules.filter((rule) => rule.enabled !== false).length} 条启用）`)
  lines.push(`- 会话数：${trajectories.length}`)

  const totalSteps = trajectories.reduce((sum, trajectory) => sum + trajectory.steps.length, 0)
  const totalTokens = trajectories.reduce((sum, trajectory) => sum + trajectory.meta.totalTokens, 0)
  const scored = trajectories
    .map((trajectory) => cards.get(trajectory.id))
    .filter((card): card is ScoreCard => card !== undefined)
  const average =
    scored.length > 0 ? Math.round(scored.reduce((sum, card) => sum + card.overall, 0) / scored.length) : 100

  lines.push(`- 总步数：${totalSteps}`)
  lines.push(`- 估算 token：${formatTokens(totalTokens)}`)
  lines.push(`- 平均分：${average}`)
  lines.push('')

  lines.push('## 总览')
  lines.push('')
  lines.push('| 会话 | 步骤 | token | 总分 | 等级 | 严重 | 警告 | 提示 |')
  lines.push('| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |')
  for (const trajectory of trajectories) {
    const card = cards.get(trajectory.id)
    if (!card) continue
    lines.push(
      `| ${escapeCell(trajectory.label)} | ${trajectory.steps.length} | ${formatTokens(
        trajectory.meta.totalTokens,
      )} | ${card.overall} | ${card.grade} | ${card.counts.error} | ${card.counts.warn} | ${card.counts.info} |`,
    )
  }
  lines.push('')

  trajectories.forEach((trajectory, index) => {
    const card = cards.get(trajectory.id)
    if (!card) return

    lines.push(`## ${index + 1}. ${trajectory.label}`)
    lines.push('')
    lines.push(`**总分 ${card.overall} / ${card.grade} · ${card.gradeLabel}**`)
    lines.push('')
    if (card.capped) {
      lines.push(`> 加权分 ${card.rawOverall}，因存在严重问题（error 级规则）封顶至 ${card.overall}。`)
      lines.push('')
    }
    if (trajectory.meta.model) lines.push(`- 模型：${trajectory.meta.model}`)
    if (trajectory.meta.estimatedTokens) lines.push('- token 为字符估算值，非上游上报')
    lines.push('')

    lines.push('| 维度 | 得分 | 扣分 | 问题数 |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const dimension of card.dimensions) {
      lines.push(`| ${dimension.label} | ${dimension.score} | ${dimension.lost} | ${dimension.findings} |`)
    }
    lines.push('')

    if (card.findings.length === 0) {
      lines.push('未发现问题。')
      lines.push('')
      return
    }

    lines.push('### 问题清单')
    lines.push('')
    card.findings.forEach((finding, findingIndex) => {
      const location = finding.stepIndex !== undefined ? ` · 第 ${finding.stepIndex + 1} 步` : ''
      lines.push(
        `${findingIndex + 1}. **${SEVERITY_TEXT[finding.severity] ?? finding.severity}** · **${finding.ruleTitle}**${location}`,
      )
      lines.push(`   - 详情：${escapeCell(finding.message)}`)
      if (finding.evidence) lines.push(`   - 证据：${escapeCell(finding.evidence)}`)
    })
    lines.push('')
  })

  if (scored.some((card) => card.ruleIssues.length > 0)) {
    lines.push('## 规则异常')
    lines.push('')
    const seen = new Set<string>()
    for (const card of scored) {
      for (const issue of card.ruleIssues) {
        const key = `${issue.ruleId}:${issue.message}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`- \`${issue.ruleId}\`：${issue.message}`)
      }
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('由轨迹质检台生成。评分口径：各维度满分 100，按严重度加权扣分，单条规则最多计 3 次；总分取维度加权平均。存在严重问题（error 级规则）时按数量封顶：≥1 条 74 分、≥3 条 54 分、≥5 条 39 分。')
  lines.push('')

  return lines.join('\n')
}

export function buildJsonReport(input: {
  trajectories: Trajectory[]
  cards: Map<string, ScoreCard>
  pack: RulePack
  generatedAt: Date
}): string {
  const { trajectories, cards, pack, generatedAt } = input
  return JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      rulePack: { name: pack.name, version: pack.version, rules: pack.rules.length },
      sessions: trajectories.map((trajectory) => {
        const card = cards.get(trajectory.id)
        return {
          id: trajectory.id,
          label: trajectory.label,
          source: trajectory.source,
          steps: trajectory.steps.length,
          tokens: trajectory.meta.totalTokens,
          estimatedTokens: trajectory.meta.estimatedTokens,
          score: card?.overall ?? null,
          grade: card?.grade ?? null,
          dimensions: card?.dimensions ?? [],
          counts: card?.counts ?? { error: 0, warn: 0, info: 0 },
          findings: card?.findings ?? [],
          ruleIssues: card?.ruleIssues ?? [],
          parseNotes: trajectory.parseNotes,
        }
      }),
    },
    null,
    2,
  )
}

export const SEVERITY_COLORS = SEVERITY_COLOR
