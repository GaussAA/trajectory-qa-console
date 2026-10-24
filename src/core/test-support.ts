/** 仅供测试文件导入的构造函数，生产代码不得引用。
 *  各层的测试都在重复写「造一条结构正确的会话」「造一个 Step」；收在这里，改数据模型时只改一处。
 *  放在 core 里是因为它只依赖 core，任何一层的测试向下导入都不违反分层。 */

import { analyze, type SessionAnalysis } from './analysis'
import type { Step } from './model'

/** 一问一答的最小轨迹，`analyze` 能原样解析。 */
export const REIMBURSEMENT_TRACE = JSON.stringify([
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元。' },
])

/** 分析一段原文，失败就抛，省得每个用例自己判 `ok`。 */
export function analyzeSessions(source: string, label = 'trace.json'): SessionAnalysis[] {
  const parsed = analyze({ source, label })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.sessions
}

/** 借 `analyze` 造一条结构正确的会话，省得手写 Step 的每个字段。 */
export function reimbursementSessions(): SessionAnalysis[] {
  return analyzeSessions(REIMBURSEMENT_TRACE, 'a.json')
}

/** 手写一个 Step；`toolNames` 里每个名字对应一次参数合法的工具调用。 */
export function makeStep(index: number, role: Step['role'], text: string, toolNames: string[] = []): Step {
  return {
    index,
    role,
    text,
    reasoning: '',
    toolCalls: toolNames.map((name, position) => ({
      id: `c${index}-${position}`,
      name,
      rawArgs: '{}',
      args: {},
      argsValid: true,
    })),
    tokens: { input: 0, output: 0, total: 0, estimated: true },
    charCount: text.length,
    raw: {},
    parseNotes: [],
  }
}
