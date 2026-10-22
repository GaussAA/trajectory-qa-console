import { describe, expect, it } from 'vitest'
import { ExprError, compileExpression, evaluateExpression, evaluatePredicate } from './expr'

describe('expression evaluation', () => {
  it('applies arithmetic precedence', () => {
    expect(evaluateExpression('1 + 2 * 3', {})).toBe(7)
    expect(evaluateExpression('(1 + 2) * 3', {})).toBe(9)
    expect(evaluateExpression('10 / 4', {})).toBe(2.5)
    expect(evaluateExpression('10 % 4', {})).toBe(2)
  })

  it('supports word and symbol boolean operators', () => {
    expect(evaluatePredicate('true and not false', {})).toBe(true)
    expect(evaluatePredicate('false or true', {})).toBe(true)
    expect(evaluatePredicate('true && false || true', {})).toBe(true)
    expect(evaluatePredicate('!true', {})).toBe(false)
  })

  it('reads nested context fields', () => {
    const context = {
      steps: 12,
      toolCalls: 4,
      errorRate: 0.5,
      role: 'assistant',
      toolNames: ['search', 'fetch'],
    }
    expect(evaluatePredicate('toolCalls > 2 && errorRate >= 0.5', context)).toBe(true)
    expect(evaluatePredicate('role == "assistant"', context)).toBe(true)
    expect(evaluatePredicate('toolNames[0] == "search"', context)).toBe(true)
    expect(evaluateExpression('len(toolNames)', context)).toBe(2)
    expect(evaluateExpression('round(errorRate * 100)', context)).toBe(50)
  })

  it('compares strings and numbers without surprising coercion', () => {
    expect(evaluatePredicate('"b" > "a"', {})).toBe(true)
    expect(evaluatePredicate('5 == "5"', {})).toBe(true)
    expect(evaluatePredicate('5 != 6', {})).toBe(true)
  })

  it('exposes a whitelist of functions only', () => {
    expect(evaluatePredicate('includes(text, "失败")', { text: '工具失败' })).toBe(true)
    expect(evaluateExpression('sum([1, 2, 3])', {})).toBe(6)
    expect(evaluateExpression('max(3, 9)', {})).toBe(9)
    expect(evaluatePredicate('any([false, true])', {})).toBe(true)
  })

  it('rejects unknown identifiers and fields instead of silently passing', () => {
    expect(() => evaluatePredicate('unknownMetric > 0', {})).toThrowError(ExprError)
    expect(() => evaluatePredicate('cfg.missing == 1', { cfg: { present: 1 } })).toThrowError(
      /未知字段/,
    )
  })

  it('blocks prototype-walking property access', () => {
    expect(() => evaluateExpression('cfg.constructor', { cfg: {} })).toThrowError(/禁止访问字段/)
    expect(() => evaluateExpression('cfg["__proto__"]', { cfg: {} })).toThrowError(/禁止访问字段/)
  })

  it('reports syntax errors with a position', () => {
    expect(() => evaluateExpression('1 +', {})).toThrowError(ExprError)
    expect(() => evaluateExpression('(1 + 2', {})).toThrowError(/缺少/)
  })

  it('compiles once and reports the fields an expression reads', () => {
    const compiled = compileExpression('toolCalls > 2 and errorRate >= 0.5')
    expect([...compiled.identifiers].sort()).toEqual(['errorRate', 'toolCalls'])
    expect(compiled.run({ toolCalls: 3, errorRate: 0.6 })).toBe(true)
    expect(compiled.run({ toolCalls: 1, errorRate: 0.6 })).toBe(false)
  })

  it('rejects unknown functions at compile time, not at evaluation time', () => {
    expect(() => compileExpression('lenght(role) > 0')).toThrowError(/多余的内容|未知/)
  })

  it('enforces expression size limits', () => {
    expect(() => compileExpression('1'.repeat(1200))).toThrowError(/过长/)
  })

  it('allows unknown identifiers to compile so the contract can suggest a fix', () => {
    const compiled = compileExpression('unpairedCallz > 0')
    expect(compiled.identifiers).toEqual(['unpairedCallz'])
    expect(() => compiled.run({ unpairedCalls: 1 })).toThrowError(/未知标识符/)
  })
})
