/** LLM 调用的共同底座：一次超时、一处重试判据、一个可注入传输层。
 *
 *  这份文件存在的理由，是这个项目已经为「同一件事算两遍」付过四次代价
 *  （MD/JSON/HTML 各算一遍对比 diff、三个人工消费方）。语义复核与智能体是
 *  同一类调用：同一端点、同一密钥、同一套脱敏纪律。分叉成两套超时与重试，
 *  迟早只有一套被人想起来改。
 *
 *  密钥只进请求头，绝不进日志或错误信息——零信任那条线在这里落地。
 */

export interface LlmRequest {
  url: string
  model: string
  apiKey: string
  body: string
  signal?: AbortSignal
}

export interface LlmResponse {
  ok: boolean
  status: number
  text: string
}

/** 传输层可注入：测试用假实现，运行时用 fetch。 */
export type LlmTransport = (request: LlmRequest) => Promise<LlmResponse>

export const fetchTransport: LlmTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${request.apiKey}`,
    },
    body: request.body,
    signal: request.signal,
  })
  return { ok: response.ok, status: response.status, text: await response.text() }
}

/** 只重试「服务端可能自愈」的失败；4xx 重试无益，只会多烧配额。 */
export const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 超时即主动 abort 在途请求：不 abort 的话，定时器赢了、连接还挂着。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('timeout'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
