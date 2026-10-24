/** `sem-privacy-leak` 是 error 级，一次命中就把总分封顶在 74。
 *  所以这里既要锁「该报的报」，也要锁「不该报的不报」：误报和漏报都直接改变分数。 */

import { describe, expect, it } from 'vitest'
import { countPrivacyHits, isPlausibleChineseId } from './privacy'

describe('countPrivacyHits: things that are leaks', () => {
  it.each([
    ['mainland mobile', '联系 13812345678 确认'],
    ['email', '发到 someone@example.com 即可'],
    ['valid national id', '证件号 440106199001011235'],
    ['national id with upper X', '证件号 11010519491231002X'],
    ['national id with lower x', '证件号 11010519491231002x'],
    ['legacy sk- key', 'key sk-abcdefghij0123456789xyz'],
    ['sk-proj key', 'key sk-proj-AbCdEfGhIjKlMnOpQr0123_xyz-ABC'],
    ['sk-ant key', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQr0123'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS temporary key id', 'ASIAIOSFODNN7EXAMPLE'],
    ['GitHub classic token', `ghp_${'a1B2c3D4'.repeat(5)}`],
    ['GitHub fine-grained token', `github_pat_${'A1b2C3d4E5'.repeat(6)}`],
    ['PEM private key header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['PEM private key header (no algorithm)', '-----BEGIN PRIVATE KEY-----'],
  ])('flags %s', (_name, text) => {
    expect(countPrivacyHits(text)).toBe(1)
  })

  it('counts every distinct hit in one message', () => {
    expect(countPrivacyHits('手机 13812345678，邮箱 a@b.co，密钥 AKIAIOSFODNN7EXAMPLE')).toBe(3)
  })
})

describe('countPrivacyHits: things that are not leaks', () => {
  it.each([
    ['an 18-digit order number', 'order 202401011234567890 shipped'],
    ['an 18-digit number with a bad checksum', '110101199001011234'],
    ['an 18-digit number with an impossible date', '110101199013011237'],
    ['a 19-digit snowflake id', '1234567890123456789'],
    ['a hyphenated word starting with sk-', 'we use sk-learn-pipeline-builder-helpers here'],
    ['a short sk- prefix', 'sk-abc123'],
    ['an AKIA prefix that is too short', 'AKIA12345'],
    ['the word ghp_ alone', 'the ghp_ prefix marks a GitHub token'],
    ['a public key header', '-----BEGIN PUBLIC KEY-----'],
    ['a certificate header', '-----BEGIN CERTIFICATE-----'],
    ['an 11-digit number that is not a phone', '23812345678'],
    ['plain prose', 'The quarterly report is attached.'],
  ])('ignores %s', (_name, text) => {
    expect(countPrivacyHits(text)).toBe(0)
  })
})

describe('isPlausibleChineseId', () => {
  it('accepts a correct checksum and rejects a wrong one', () => {
    expect(isPlausibleChineseId('440106199001011235')).toBe(true)
    expect(isPlausibleChineseId('440106199001011234')).toBe(false)
  })

  it('rejects dates that cannot exist, including Feb 30 and month 13', () => {
    expect(isPlausibleChineseId('440106199002301230')).toBe(false)
    expect(isPlausibleChineseId('440106199013011230')).toBe(false)
  })

  it('accepts Feb 29 only in a leap year', () => {
    // 末位按各自前 17 位重算过，所以只有日期合法性决定结果。
    expect(isPlausibleChineseId(withChecksum('44010620000229123'))).toBe(true)
    expect(isPlausibleChineseId(withChecksum('44010619000229123'))).toBe(false)
  })

  it('rejects anything that is not 18 characters of the right shape', () => {
    expect(isPlausibleChineseId('44010619900101123')).toBe(false)
    expect(isPlausibleChineseId('44010619900101123ab')).toBe(false)
  })
})

describe('countPrivacyHits: cost on hostile input', () => {
  // 原邮箱正则的本地部分是无界的 `+`，在不含 @ 的长串上二次方耗时：8 万字符约 5 秒。
  // 阈值留得很宽，只是为了抓住「又退回二次方」，不是性能基准。
  it.each([
    ['a long run with no @', 'a'.repeat(80_000)],
    ['a long run of local-part characters with dots', 'ab.'.repeat(30_000)],
    ['many @ signs', '@a'.repeat(40_000)],
    ['a long digit run', '1'.repeat(80_000)],
  ])('stays fast on %s', (_name, text) => {
    const started = performance.now()
    countPrivacyHits(text)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

/** 给 17 位前缀补上正确的校验位。 */
function withChecksum(prefix: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const sum = [...prefix].reduce((acc, digit, i) => acc + Number(digit) * (weights[i] as number), 0)
  return prefix + '10X98765432'[sum % 11]
}
