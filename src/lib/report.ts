import type { ScoreCard } from '../core/analysis'
import type { RulePack, Trajectory } from '../core/model'
import { formatTokens } from '../core/estimate'

const SEVERITY_TEXT: Record<string, string> = { error: '严重', warn: '警告', info: '提示' }

/** One session's report material. Passing entries — not two collections keyed by
 *  an id — removes the chance of the card and the trajectory drifting apart. */
export interface ReportEntry {
  trajectory: Trajectory
  card: ScoreCard
}

export interface ReportInput {
  entries: ReportEntry[]
  pack: RulePack
  generatedAt: Date
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

export function buildMarkdownReport({ entries, pack, generatedAt }: ReportInput): string {
  const lines: string[] = []

  lines.push('# 轨迹质检报告')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt.toLocaleString('zh-CN')}`)
  lines.push(`- 规则包：${pack.name}（${pack.rules.filter((rule) => rule.enabled !== false).length} 条启用）`)
  lines.push(`- 会话数：${entries.length}`)

  const totalSteps = entries.reduce((sum, entry) => sum + entry.trajectory.steps.length, 0)
  const totalTokens = entries.reduce((sum, entry) => sum + entry.trajectory.meta.totalTokens, 0)
  const average =
    entries.length > 0
      ? Math.round(entries.reduce((sum, entry) => sum + entry.card.overall, 0) / entries.length)
      : 100

  lines.push(`- 总步数：${totalSteps}`)
  lines.push(`- 估算 token：${formatTokens(totalTokens)}`)
  lines.push(`- 平均分：${average}`)
  lines.push('')

  lines.push('## 总览')
  lines.push('')
  lines.push('| 会话 | 步骤 | token | 总分 | 等级 | 严重 | 警告 | 提示 |')
  lines.push('| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |')
  for (const { trajectory, card } of entries) {
    lines.push(
      `| ${escapeCell(trajectory.label)} | ${trajectory.steps.length} | ${formatTokens(
        trajectory.meta.totalTokens,
      )} | ${card.overall} | ${card.grade} | ${card.counts.error} | ${card.counts.warn} | ${card.counts.info} |`,
    )
  }
  lines.push('')

  entries.forEach(({ trajectory, card }, index) => {
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

  if (entries.some((entry) => entry.card.ruleIssues.length > 0)) {
    lines.push('## 规则异常')
    lines.push('')
    const seen = new Set<string>()
    for (const { card } of entries) {
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
  lines.push(
    '由轨迹质检台生成。评分口径：各维度满分 100，按严重度加权扣分，单条规则最多计 3 次；总分取维度加权平均。存在严重问题（error 级规则）时按数量封顶：≥1 条 74 分、≥3 条 54 分、≥5 条 39 分。',
  )
  lines.push('')

  return lines.join('\n')
}

export function buildJsonReport({ entries, pack, generatedAt }: ReportInput): string {
  return JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      rulePack: { name: pack.name, version: pack.version, rules: pack.rules.length },
      sessions: entries.map(({ trajectory, card }) => ({
        id: trajectory.id,
        label: trajectory.label,
        source: trajectory.source,
        steps: trajectory.steps.length,
        tokens: trajectory.meta.totalTokens,
        estimatedTokens: trajectory.meta.estimatedTokens,
        score: card.overall,
        rawScore: card.rawOverall,
        grade: card.grade,
        dimensions: card.dimensions,
        counts: card.counts,
        findings: card.findings,
        ruleIssues: card.ruleIssues,
        parseNotes: trajectory.parseNotes,
      })),
    },
    null,
    2,
  )
}
