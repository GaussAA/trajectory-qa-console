/** 诊断报告的两种出口：Markdown 与 JSON，同一份 model 渲染。
 *
 *  「算一次、渲染多份」是这个项目付过四次代价换来的习惯（MD/JSON/HTML 各算一遍
 *  对比 diff）。这份报告同理：状态文案、调用记录、统计只算一次。
 *
 *  报告刻意把「模型归纳」与「工具证据」分成两节。原因不是排版喜好：
 *  模型可以编数字，工具不会。分成两节，读者一眼能看出哪句话是判断、哪个数字是事实。
 */

import type { AgentRun, TraceEntry } from '../core/agent/types'
import type { RulePack } from '../core/model'
import type { SessionAnalysis } from '../core/analysis'
import { hasMessage, translate, type Locale, type MessageKey } from '../i18n/core'
import { mdBlock, mdCell, mdCode, mdInline } from './markdown'

export interface AgentReportInput {
  run: AgentRun
  sessions: SessionAnalysis[]
  pack: RulePack
  model: string
  /** 端点完整地址；渲染时只取 host，避免把带签名的代理路径写进报告。 */
  endpoint: string
  generatedAt: Date
  locale: Locale
}

interface TraceRow {
  round: number
  tool: string
  args: string
  ok: boolean
  result: string
  ms: number
}

export interface AgentReportModel {
  /** 状态一句话（已收尾 / 未收敛 / 失败）。 */
  status: string
  /** 未收敛或失败时的补充说明；正常收尾为 null。 */
  statusNote: string | null
  traceRows: TraceRow[]
  toolCalls: number
  rounds: number
  durationMs: number
  endpointHost: string
}

function t(locale: Locale, key: string, params?: Record<string, string | number>): string {
  return hasMessage(locale, key) ? translate(locale, key as MessageKey, params) : key
}

function escapeCell(text: string): string {
  return mdCell(text).trim()
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

function toolRows(entries: TraceEntry[]): TraceRow[] {
  return entries
    .filter((entry): entry is Extract<TraceEntry, { kind: 'tool' }> => entry.kind === 'tool')
    .map((entry) => ({
      round: entry.round,
      tool: entry.name,
      args: entry.args,
      ok: entry.ok,
      result: entry.result,
      ms: entry.ms,
    }))
}

export function buildAgentReportModel(input: AgentReportInput): AgentReportModel {
  const { run, locale } = input
  const rows = toolRows(run.trace.entries)

  let status: string
  let statusNote: string | null = null
  if (!run.ok) {
    status = t(locale, 'agent.status.failed')
    statusNote = run.error?.message ?? null
  } else if (run.trace.truncated) {
    status = t(locale, 'agent.status.truncated')
    statusNote = t(locale, `agent.stop.${run.trace.stopReason}`)
  } else {
    status = t(locale, `agent.status.${run.trace.stopReason}`)
  }

  return {
    status,
    statusNote,
    traceRows: rows,
    toolCalls: run.trace.toolCalls,
    rounds: run.trace.rounds,
    durationMs: run.trace.entries.reduce((sum, entry) => sum + entry.ms, 0),
    endpointHost: endpointHost(input.endpoint),
  }
}

/** 报告是给人读的：会话名比 id 好认，所以优先 label；
 *  找不到对应会话时才退回 id（模型引用的是 id，读者至少能对上号）。 */
function sessionLabel(sessions: SessionAnalysis[], id: string | undefined): string | null {
  if (!id) return null
  const session = sessions.find((item) => item.id === id)
  return session ? session.trajectory.label : id
}

export function renderAgentMarkdown(input: AgentReportInput, model?: AgentReportModel): string {
  const built = model ?? buildAgentReportModel(input)
  const { run, locale, sessions } = input
  const lines: string[] = []

  lines.push(`# ${t(locale, 'agent.report.title')}`, '')
  const field = (key: string, value: string | number): string =>
    `${t(locale, key)}${t(locale, 'agent.report.sep')}${value}`
  lines.push(`- ${field('agent.report.generatedAt', input.generatedAt.toISOString())}`)
  lines.push(
    `- ${field('agent.report.model', `${mdInline(input.model)} @ ${mdInline(built.endpointHost)}`)}`,
  )
  lines.push(`- ${field('agent.report.pack', mdInline(input.pack.name))}`)
  lines.push(`- ${field('agent.report.sessions', input.sessions.length)}`)
  lines.push(`- ${field('agent.report.status', built.status)}`)
  if (built.statusNote) lines.push(`- ${built.statusNote}`)
  lines.push('')

  lines.push(`## ${t(locale, 'agent.report.conclusion')}`, '')
  lines.push(`> ${t(locale, 'agent.report.conclusionNote')}`, '')

  // 运行失败时不展示半截输出：中断前的模型文本容易被读成结论。
  // 失败原因在上方状态行，这里只如实说「没有结论」。
  const verdict = run.ok ? (run.diagnosis?.verdict ?? run.answer) : ''
  lines.push(verdict.trim() === '' ? t(locale, 'agent.report.noConclusion') : mdBlock(verdict.trim()), '')

  const rootCauses = run.diagnosis?.rootCauses ?? []
  if (rootCauses.length > 0) {
    lines.push(`### ${t(locale, 'agent.report.rootCauses')}`, '')
    for (const item of rootCauses) {
      const where = sessionLabel(sessions, item.session)
      const prefix = where ? `**${mdInline(where)}** · ` : ''
      lines.push(`- ${prefix}${mdInline(item.cause)}`)
      // 模型给的字段不可全信（也可能是旧版本存档）：缺一个字段就让整份报告崩掉，
      // 与「单条坏数据不得影响其余部分」相悖。
      if ((item.evidence ?? '').trim() !== '') {
        lines.push(`  - ${field('agent.report.evidence', mdInline(item.evidence ?? ''))}`)
      }
    }
    lines.push('')
  }

  const actions = run.diagnosis?.actions ?? []
  if (actions.length > 0) {
    lines.push(`### ${t(locale, 'agent.report.actions')}`, '')
    for (const item of actions) {
      const rule = item.ruleId ? ` ${mdCode(item.ruleId)}` : ''
      lines.push(`- ${mdInline(item.action)}${rule}`)
      if ((item.rationale ?? '').trim() !== '') {
        lines.push(`  - ${field('agent.report.rationale', mdInline(item.rationale ?? ''))}`)
      }
    }
    lines.push('')
  }

  // 提案单列一节：它不会自动生效，必须让人看清「这是候选」再决定要不要试。
  if (run.proposals.length > 0) {
    lines.push(`## ${t(locale, 'agent.report.proposals')}`, '')
    lines.push(`> ${t(locale, 'agent.report.proposalNote')}`, '')
    for (const proposal of run.proposals) {
      lines.push(`### ${mdInline(proposal.id)} · ${mdInline(proposal.rationale)}`, '')
      for (const applied of proposal.applied) {
        lines.push(
          `- ${mdCode(applied.ruleId)} → ${applied.severity} · ${t(locale, 'agent.report.proposalImpact', {
            impact: applied.effectiveImpact,
          })}`,
        )
      }
      lines.push(
        '',
        `- ${t(locale, 'agent.report.proposalDelta', {
          before: proposal.averageBefore,
          after: proposal.averageAfter,
          delta: proposal.delta > 0 ? `+${proposal.delta}` : String(proposal.delta),
        })}`,
        '',
      )
    }
  }

  lines.push(`## ${t(locale, 'agent.report.trace')}`, '')
  if (built.traceRows.length === 0) {
    lines.push(t(locale, 'agent.report.noTrace'), '')
  } else {
    lines.push(
      `| ${t(locale, 'agent.report.col.round')} | ${t(locale, 'agent.report.col.tool')} | ${t(locale, 'agent.report.col.args')} | ${t(locale, 'agent.report.col.result')} | ${t(locale, 'agent.report.col.ms')} |`,
    )
    lines.push('| --- | --- | --- | --- | --- |')
    for (const row of built.traceRows) {
      const mark = row.ok ? 'ok' : '✗'
      lines.push(
        `| ${row.round} | ${escapeCell(row.tool)} | ${escapeCell(clip(row.args, 60))} | ${mark} · ${escapeCell(clip(row.result, 120))} | ${row.ms} |`,
      )
    }
    lines.push('')
  }

  lines.push(`## ${t(locale, 'agent.report.stats')}`, '')
  lines.push(
    `- ${field('agent.report.stats.rounds', built.rounds)}`,
    `- ${field('agent.report.stats.toolCalls', built.toolCalls)}`,
    `- ${field(
      'agent.report.stats.tokens',
      `${run.usage.prompt + run.usage.completion}${t(locale, 'agent.report.paren', {
        text: t(locale, 'agent.report.stats.tokensDetail', {
          prompt: run.usage.prompt,
          completion: run.usage.completion,
        }),
      })}`,
    )}`,
    `- ${field('agent.report.stats.duration', `${built.durationMs}ms`)}`,
  )
  lines.push('')

  return `${lines.join('\n')}\n`
}

/** 键名稳定，只本地化值（与 ADR-0006 同一条边界）。 */
export function renderAgentJson(input: AgentReportInput, model?: AgentReportModel): string {
  const built = model ?? buildAgentReportModel(input)
  return `${JSON.stringify(
    {
      generatedAt: input.generatedAt.toISOString(),
      locale: input.locale,
      model: input.model,
      endpoint: built.endpointHost,
      pack: input.pack.name,
      sessionCount: input.sessions.length,
      ok: input.run.ok,
      error: input.run.error ?? null,
      truncated: input.run.trace.truncated,
      stopReason: input.run.trace.stopReason,
      status: built.status,
      conclusion: input.run.diagnosis,
      answer: input.run.answer,
      // 完整候选包另存 proposal.pack.json（可直接 --pack）；这里只放摘要，避免同一份数据两处漂移。
      proposals: input.run.proposals.map((proposal) => ({
        id: proposal.id,
        rationale: proposal.rationale,
        edits: proposal.edits,
        applied: proposal.applied,
        packName: proposal.pack.name,
        averageBefore: proposal.averageBefore,
        averageAfter: proposal.averageAfter,
        delta: proposal.delta,
        rows: proposal.rows,
      })),
      trace: input.run.trace.entries,
      usage: input.run.usage,
    },
    null,
    2,
  )}\n`
}
