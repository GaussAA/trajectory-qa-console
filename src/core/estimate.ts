/** Token estimation used when a trace does not report usage.
 *
 *  We cannot run the provider's tokenizer offline, so this is a heuristic:
 *  CJK glyphs are ~1 token each (a bit less in practice), Latin text is ~4
 *  chars per token. Every value produced here is flagged `estimated: true`
 *  so the UI never presents it as ground truth.
 */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1
    else other += 1
  }
  return Math.round(cjk * 0.9 + other / 4)
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
