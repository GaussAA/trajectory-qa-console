/** 读 OpenAI 兼容响应的两个动作：取内容、看形状。
 *
 *  放在 `core/llm` 而不是语义模块里，是因为智能体也要读同一种响应——两处各写
 *  一份"兼容 choices / content parts / 裸文本"的解析，迟早只改一处。
 */

export interface ResponseShape {
  content: string | null
  finishReason: string | null
  /** 思考文本长度：只用于诊断，不进任何产物。 */
  reasoningChars: number
}

/** 兼容 OpenAI 的 `choices[0].message.content`，也接受直接返回文本的代理。 */
export function extractContent(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[]
      content?: unknown
      output_text?: unknown
    }
    const choice = parsed.choices?.[0]?.message?.content
    if (typeof choice === 'string' && choice.trim()) return choice
    if (Array.isArray(choice)) {
      // 部分供应商把 content 拆成 parts
      const text = choice
        .map((part) =>
          typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '',
        )
        .join('')
      if (text.trim()) return text
    }
    if (typeof parsed.content === 'string') return parsed.content
    if (typeof parsed.output_text === 'string') return parsed.output_text
    return null
  } catch {
    // 不是 JSON：某些本地代理直接回文本
    return raw.trim() ? raw : null
  }
}

export function inspectResponse(raw: string): ResponseShape {
  const content = extractContent(raw)
  try {
    const parsed = JSON.parse(raw) as {
      choices?: { message?: { reasoning?: unknown }; finish_reason?: unknown }[]
    }
    const choice = parsed.choices?.[0]
    const reasoning = choice?.message?.reasoning
    return {
      content,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
    }
  } catch {
    return { content, finishReason: null, reasoningChars: 0 }
  }
}
