/** 敏感信息检测：`sem-privacy-leak` 规则（error 级，会触发总分封顶）的数据来源。
 *
 *  这是启发式，不是 DLP：宁可少报，也不能让一个订单号把一条健康轨迹封顶在 74。
 *  所以每个检测器可以带一个校验函数——正则只负责「形状像」，校验负责「确实像」。
 *
 *  已知边界：只扫助手的文本输出，不扫 tool_call 参数。规则文案写的是「助手输出中」。
 */

interface Detector {
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

const DETECTORS: Detector[] = [
  // 大陆手机号
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  // 邮箱。本地部分限 64 位（RFC 5321 上限）：原先的 `+` 无界，在一长串不含 @ 的字符上
  // 每个起点都扫到串尾，二次方耗时（8 万字符约 5 秒）。
  { pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
  // 18 位证件号：形状 + 出生日期 + 校验位。任意 18 位数字（订单号、雪花 ID）不算。
  { pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, accept: isPlausibleChineseId },
  // OpenAI 风格：旧式 `sk-xxxx`，以及 `sk-proj-…` / `sk-ant-api03-…`。
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, accept: looksLikeSecretKey },
  // AWS 访问密钥 ID
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub 令牌
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  // PEM 私钥块头
  { pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
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
