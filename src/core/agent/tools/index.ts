/** 工具集：模型能做的每一件事，都落到一个已有的纯函数上。
 *
 *  设计上只有一条硬纪律——**数字只能来自这里**。模型可以选、可以归因、可以提议，
 *  但不能自己算：报告里的分数、命中数、模拟涨幅全部由这些工具产出，因此可审计。
 *
 *  全部工具都是只读或纯计算：没有一个会改动工作区、规则包或轨迹文件。
 *  `simulate_pack` 造的是**草稿包**，只存在于这次调用里，且必须过 `validatePack`。
 */

import type { Tool } from '../types'
import { submitDiagnosis } from './diagnosis'
import {
  compareSessionsTool,
  getCard,
  getFindings,
  getStep,
  listSessions,
  readSteps,
  searchSteps,
} from './inspect'
import { listRules, proposePack, simulatePack, tuneLiteral } from './pack'

export { parseDiagnosis } from './diagnosis'

export const TOOLS: Tool[] = [
  listSessions,
  getCard,
  getFindings,
  readSteps,
  getStep,
  searchSteps,
  listRules,
  simulatePack,
  tuneLiteral,
  compareSessionsTool,
  // 提案排在终结工具之前：模型先算、再提议、最后收尾，顺序与它的调用习惯一致。
  proposePack,
  submitDiagnosis,
]

export const TERMINAL_TOOL = submitDiagnosis.spec.name

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.spec.name === name)
}

export function toolSpecs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return TOOLS.map((tool) => tool.spec)
}
