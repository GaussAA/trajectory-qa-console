/** 终结工具：提交最终诊断。调用后循环立即停止。 */

import type { Diagnosis, Tool } from '../types'
import { readString, reject } from './shared'

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

export const submitDiagnosis: Tool = {
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
