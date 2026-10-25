/** 会话查看类工具：只读已分析的会话，不碰规则包。 */

import { compareCards, diffFindings } from '../../compare/sessions'
import type { Step } from '../../model'
import { DIGEST_DEFAULTS, renderStep } from '../../semantic/prompt'
import type { Tool } from '../types'
import {
  cardOf,
  clip,
  findSession,
  findingView,
  isSeverity,
  readInt,
  readString,
  reject,
  unknownSession,
  wrap,
} from './shared'

export const listSessions: Tool = {
  spec: {
    name: 'list_sessions',
    description: '列出所有会话的一句话概览：分数、等级、步数、token、问题计数。诊断的第一步通常是它。',
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

export const getCard: Tool = {
  spec: {
    name: 'get_card',
    description: '读取某条会话的完整评分卡：各维度得分与权重、错误封顶、问题计数、命中最多的问题、规则异常。',
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

export const getFindings: Tool = {
  spec: {
    name: 'get_findings',
    description:
      '按维度或严重度筛选某条会话的问题清单（ruleId、严重度、步号、证据、扣分）。想定位「哪些步出问题」时用它。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        dimension: {
          type: 'string',
          description: '维度 id，如 structure / execution / efficiency / semantic',
        },
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

export const readSteps: Tool = {
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

export const getStep: Tool = {
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
      result: step.result ? { isError: step.result.isError, content: clip(step.result.content, 800) } : null,
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

export const searchSteps: Tool = {
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
        snippet: haystack
          .slice(start, at + query.length + 60)
          .replace(/\s+/g, ' ')
          .trim(),
      })
    }
    return wrap({ sessionId: session.id, query, hits, truncated: hits.length >= limit })
  },
}

export const compareSessionsTool: Tool = {
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
