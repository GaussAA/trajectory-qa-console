/** LLM 端点配置：命令行与本地服务读同一份。
 *
 *  抽出来的理由很实际：`qa serve` 也要端点与密钥，若两处各写一遍「读哪些环境变量」，
 *  迟早只有一处被更新——而密钥读取是零信任那条线，不能有两个版本。
 */

import type { CliOptions } from './args'

export interface SemanticConfig {
  url: string
  model: string
  apiKey: string
}

/** 把「版本化 base」补成完整端点：`https://host/v1` → `https://host/v1/chat/completions`。
 *
 *  只认 `/v1`、`/v1beta` 这类版本尾巴——其余一律原样返回。
 *  不这么做的话，本地代理那种自带路径的地址（`http://127.0.0.1:18880/api/chat`）
 *  会被拼成 `.../api/chat/chat/completions`，等于把一个能用的配置改坏。 */
export function chatCompletionsUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  if (/\/v\d+[a-z]*$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return trimmed
}

export type ResolvedConfig = { ok: true; config: SemanticConfig } | { ok: false; missing: string[] }

/** 密钥只从环境变量读：不落盘、不进命令行历史、不进日志。 */
export function resolveSemantic(
  options: Pick<CliOptions, 'llmUrl' | 'llmModel'>,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const url = chatCompletionsUrl(options.llmUrl ?? env.TQA_LLM_URL ?? env.TQA_LLM_BASE_URL ?? '')
  const model = options.llmModel ?? env.TQA_LLM_MODEL ?? ''
  const apiKey = env.TQA_LLM_API_KEY ?? ''
  const missing: string[] = []
  if (!url) missing.push('--llm-url / TQA_LLM_URL / TQA_LLM_BASE_URL')
  if (!model) missing.push('--llm-model / TQA_LLM_MODEL')
  if (!apiKey) missing.push('TQA_LLM_API_KEY')
  return missing.length > 0 ? { ok: false, missing } : { ok: true, config: { url, model, apiKey } }
}
