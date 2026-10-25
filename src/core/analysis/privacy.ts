/** 敏感信息检测：`sem-privacy-leak` 规则（error 级，会触发总分封顶）的数据来源，
 *  也是发往第三方模型端点之前脱敏的依据——「什么算敏感」只有这一份定义。
 *
 *  这是启发式，不是 DLP：宁可少报，也不能让一个订单号把一条健康轨迹封顶在 74。
 *  所以每个检测器可以带一个校验函数——正则只负责「形状像」，校验负责「确实像」。
 *
 *  已知边界：计分只扫助手的文本输出，不扫 tool_call 参数。规则文案写的是「助手输出中」。
 *  脱敏则不分角色，凡是要发出去的文本都过一遍。
 */

interface Detector {
  /** 脱敏时换成 `[REDACTED:<label>]`。 */
  label: 'email' | 'phone' | 'id' | 'key'
  pattern: RegExp
  /** 命中后的二次确认；省略则正则命中即算。 */
  accept?: (match: string) => boolean
}

/** 18 位居民身份证：校验位按 GB 11643（ISO 7064 MOD 11-2）。 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = '10X98765432'

export function isPlausibleChineseId(value: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(value)) return false

  const year = Number(value.slice(6, 10))
  const month = Number(value.slice(10, 12))
  const day = Number(value.slice(12, 14))
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false

  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += Number(value[i]) * (ID_WEIGHTS[i] as number)
  return ID_CHECK[sum % 11] === value[17]?.toUpperCase()
}

/** 旧式 `sk-` 密钥是纯字母数字；新式（`sk-proj-`、`sk-ant-api03-`）带连字符和下划线。
 *  真密钥是随机串，几乎必含数字；`sk-learn-pipeline-builder` 这类词不含，据此排除。 */
function looksLikeSecretKey(match: string): boolean {
  return /\d/.test(match)
}

// 邮箱排在手机号前面：`13812345678@qq.com` 先按邮箱整体替换，否则手机号先被换掉，剩下的域名会漏出去。
const DETECTORS: Detector[] = [
  // 邮箱。本地部分限 64 位（RFC 5321 上限）：原先的 `+` 无界，在一长串不含 @ 的字符上
  // 每个起点都扫到串尾，二次方耗时（8 万字符约 5 秒）。
  { label: 'email', pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
  // 大陆手机号
  { label: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  // 18 位证件号：形状 + 出生日期 + 校验位。任意 18 位数字（订单号、雪花 ID）不算。
  { label: 'id', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, accept: isPlausibleChineseId },
  // OpenAI 风格：旧式 `sk-xxxx`，以及 `sk-proj-…` / `sk-ant-api03-…`。
  { label: 'key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, accept: looksLikeSecretKey },
  // AWS 访问密钥 ID
  { label: 'key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub 令牌
  { label: 'key', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'key', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  // PEM 私钥块头（计数只看这一行；脱敏时整块都要拿掉，见 PEM_BLOCK）
  { label: 'key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
]

export function countPrivacyHits(text: string): number {
  let hits = 0
  for (const { pattern, accept } of DETECTORS) {
    const matches = text.match(pattern)
    if (!matches) continue
    hits += accept ? matches.filter(accept).length : matches.length
  }
  return hits
}

/** 整块 PEM 私钥：从 BEGIN 到 END。没有 END（被截断）就一路吃到结尾——宁可多拿掉，
 *  也不把半截私钥留在正文里。第一个 BEGIN 就会吃到串尾，所以是线性的，不会因为很多个 BEGIN 而变成二次方。 */
const PEM_BLOCK =
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g

/** 把密钥、手机号、邮箱、证件号形态的串换成 `[REDACTED:<类别>]`。
 *  幂等：占位符本身不会再被任何检测器命中。 */
export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, '[REDACTED:key]')
  for (const { label, pattern, accept } of DETECTORS) {
    out = out.replace(pattern, (match) => (accept && !accept(match) ? match : `[REDACTED:${label}]`))
  }
  return out
}

function mapStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(mapStrings)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[redactSecrets(key)] = mapStrings(item)
    return out
  }
  return value
}

/** 脱敏一段 JSON 文本（工具参数、工具返回值）。
 *
 *  不能直接对文本做替换：序列化后的换行是字面的 `\n` 两个字符，紧跟其后的密钥前面是字母 `n`，
 *  `\b` 判不出词边界，于是 `\nsk-proj-…` 这种最常见的写法恰好漏掉。所以先解析、只改字符串值、再序列化。
 *  解析不了（模型写坏的参数）就退回对原文本直接脱敏。 */
export function redactJsonText(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return redactSecrets(text)
  }
  return JSON.stringify(mapStrings(parsed))
}
