/** 英文内置规则包：数据在 `packs/builtin-en.json`，这里只做校验与导出。
 *
 *  为什么让 JSON 当唯一事实来源：界面可以把这个文件直接导入，命令行用
 *  `--pack en` 走同一份数据；如果这里再抄一遍规则，两边迟早不一致。
 *
 *  校验在模块加载时完成（构建期即失败），不把坏数据留到运行时。
 */

import raw from '../../../packs/builtin-en.json'
import { validatePack } from './contract'
import type { RulePack } from '../model'

const validation = validatePack(raw)
if (!validation.ok) {
  const detail = validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  throw new Error(`packs/builtin-en.json 校验失败：${detail}`)
}

export const BUILTIN_PACK_EN: RulePack = validation.pack
