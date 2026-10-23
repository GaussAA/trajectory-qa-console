import { describe, expect, it } from 'vitest'
import { analyze } from './index'

/** Synthetic trace with realistic proportions: alternating user/assistant/tool,
 *  one tool call per assistant turn, 200-char results. */
function syntheticSource(steps: number): string {
  const messages: unknown[] = [{ role: 'system', content: '你是助手，回答必须引用检索结果。' }]
  let turn = 0
  while (messages.length + 2 < steps) {
    messages.push({ role: 'user', content: `第 ${turn} 轮问题：帮我查一下政策条款。` })
    messages.push({
      role: 'assistant',
      tool_calls: [{ id: `c${turn}`, function: { name: 'search', arguments: `{"q":"q${turn}"}` } }],
    })
    messages.push({ role: 'tool', tool_call_id: `c${turn}`, content: 'x'.repeat(200) })
    turn += 1
  }
  messages.push({ role: 'assistant', content: '已完成。' })
  return JSON.stringify(messages)
}

function measure(steps: number): { ms: number; parsedSteps: number } {
  const source = syntheticSource(steps)
  const started = performance.now()
  const result = analyze({ source, label: `perf-${steps}.json` })
  const ms = performance.now() - started
  if (!result.ok) throw new Error(result.error.message)
  const analysis = result.value[0]
  if (!analysis) throw new Error('no analysis')
  return { ms, parsedSteps: analysis.trajectory.steps.length }
}

describe('analysis performance budget', () => {
  it('1k steps stays interactive', () => {
    const { ms, parsedSteps } = measure(1000)
    expect(parsedSteps).toBeGreaterThan(900)
    // Budget is deliberately loose: CI machines vary wildly. The point is to
    // catch an order-of-magnitude regression, not to benchmark hardware.
    expect(ms).toBeLessThan(500)
  }, 30_000)

  it('10k steps finishes without pathological cost', () => {
    const { ms, parsedSteps } = measure(10_000)
    expect(parsedSteps).toBeGreaterThan(9_000)
    expect(ms).toBeLessThan(3000)
  }, 60_000)

  it('scales roughly linearly rather than quadratically', () => {
    const small = measure(500).ms
    const large = measure(5_000).ms
    // Pairing used to be O(n²) in the number of unpaired calls. A 10x input
    // should not cost more than ~40x time.
    expect(large).toBeLessThan(Math.max(small * 40, 3000))
  }, 30_000)
})
