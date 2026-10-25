import { describe, expect, it } from 'vitest'
import { ExprError, compileExpression, evaluateExpression, evaluatePredicate } from './expr'

// 规则作者写的是字段名，同一个字段在不同轨迹上类型会变（缺失时是 null）。
// 下面几组用例锁住「遇到不认识的输入时到底发生什么」。这是规则的契约，悄悄改了就会改评分。

type Context = Record<string, unknown>

/** 跑一段会抛 ExprError 的代码并把错误交回来；没抛、或抛了别的错，都让测试失败。 */
function capture(run: () => unknown): ExprError {
  try {
    run()
  } catch (error) {
    if (error instanceof ExprError) return error
    throw error
  }
  throw new Error('expected an ExprError to be thrown')
}

function failure(source: string, context: Context = {}): ExprError {
  return capture(() => evaluateExpression(source, context))
}

describe('built-in functions fall back instead of throwing', () => {
  // 一条轨迹上的脏数据不该让整条规则失效，所以函数对不认识的输入退回确定的默认值。
  const cases: [string, Context, unknown][] = [
    ['len(x)', { x: null }, 0],
    ['len(x)', { x: 5 }, 0],
    ['len("abc")', {}, 3],
    ['len([1, 2])', {}, 2],
    ['includes(x, 1)', { x: [1, 2] }, true],
    ['includes(x, "1")', { x: [1, 2] }, true],
    ['includes(x, "b")', { x: 'abc' }, true],
    ['includes(x, 1)', { x: 5 }, false],
    ['any(x)', { x: 5 }, false],
    ['any([0, "", false])', {}, false],
    ['all(x)', { x: 'abc' }, false],
    ['count(x)', { x: 'abc' }, 0],
    ['count([1, 0, "a", ""])', {}, 2],
    ['sum(x)', { x: 5 }, 0],
    // 数字字符串与布尔会转成数，其余按 0 算
    ['sum([1, "2", "x", null, true])', {}, 4],
    ['round(1.2345, 2)', {}, 1.23],
    ['round(1.5)', {}, 2],
    ['round(1.23456789, 99)', {}, 1.234568], // 小数位上限 6
    ['round(1.5, -3)', {}, 2], // 负的小数位按 0 处理
    ['round("x")', {}, 0],
    ['floor(-1.5)', {}, -2],
    ['floor("x")', {}, 0],
    ['ceil(1.1)', {}, 2],
    ['ceil("x")', {}, 0],
    ['abs(-3)', {}, 3],
    ['abs("x")', {}, 0],
    ['lower(x)', { x: null }, ''],
    ['upper(x)', { x: null }, ''],
    ['lower("aB")', {}, 'ab'],
    ['upper("aB")', {}, 'AB'],
    ['startsWith("abc", "ab")', {}, true],
    ['startsWith("abc", "bc")', {}, false],
    ['startsWith(x, "a")', { x: null }, false],
    ['endsWith("abc", "bc")', {}, true],
    ['endsWith("abc", "ab")', {}, false],
  ]

  it.each(cases)('%s with %j gives %j', (source, context, expected) => {
    expect(evaluateExpression(source, context)).toEqual(expected)
  })
})

describe('operators and property access', () => {
  const cases: [string, Context, unknown][] = [
    ['-x', { x: '5' }, -5],
    ['--5', {}, 5],
    ['!x', { x: [] }, true],
    ['!x', { x: {} }, false],
    ['!x', { x: '' }, true],
    ['!x', { x: Number.NaN }, true],
    // && 与 || 返回的是操作数本身，不是布尔；左边已定结果时右边不求值（boom 是未知标识符，求值就会抛）
    ['0 && boom', {}, 0],
    ['1 || boom', {}, 1],
    ['3 && 5', {}, 5],
    ['0 || "d"', {}, 'd'],
    ['"a" + 1', {}, 'a1'],
    ['1 + "a"', {}, '1a'],
    ['1 + true', {}, 2],
    ['"5" * "2"', {}, 10],
    ['"5" - 2', {}, 3],
    ['10 > "9"', {}, true],
    // 空串、null 都不等于 0
    ['"" == 0', {}, false],
    ['null == 0', {}, false],
    ['null == null', {}, true],
    ['x[1]', { x: [10, 20] }, 20],
    ['x["1"]', { x: [10, 20] }, 20],
    ['x[5]', { x: [10, 20] }, undefined],
    ['x[-1]', { x: [10, 20] }, undefined],
    ['x.length', { x: [10, 20] }, 2],
    ['x.length', { x: 'abcd' }, 4],
  ]

  it.each(cases)('%s with %j gives %j', (source, context, expected) => {
    expect(evaluateExpression(source, context)).toEqual(expected)
  })

  it('treats the negation of a non-number as zero, which is false', () => {
    // 不直接比 -0：只需要它和 0 一样是假值
    expect(evaluatePredicate('-x', { x: 'abc' })).toBe(false)
    expect(evaluatePredicate('-x', { x: null })).toBe(false)
    expect(evaluatePredicate('-x', { x: '5' })).toBe(true)
  })

  it('does not throw on division by zero, and a NaN result counts as false', () => {
    expect(evaluateExpression('5 / 0', {})).toBe(Number.POSITIVE_INFINITY)
    expect(evaluateExpression('5 % 0', {})).toBeNaN()
    expect(evaluatePredicate('0 / 0', {})).toBe(false)
  })
})

describe('behaviours that look surprising but are pinned on purpose', () => {
  // 下面几条不一定是「想要的」行为，但内置规则包没用到它们，用户导入的规则包可能用了。
  // 改动会让已有规则包的评分悄悄变化，所以先固定住；真要改，应当同时升规则包的版本并在说明里写明。
  // 用例失败时请先想清楚：是在修一个缺陷，还是在改变别人规则的含义。

  it('treats a missing prefix or suffix as the empty string, which every text starts and ends with', () => {
    expect(evaluateExpression('startsWith("abc", p)', { p: null })).toBe(true)
    expect(evaluateExpression('endsWith(x, p)', { x: null, p: null })).toBe(true)
    // 反过来：被检查的文本缺失、而前缀非空，才是 false
    expect(evaluateExpression('startsWith(x, "a")', { x: null })).toBe(false)
  })

  it('gives min and max a zero for anything that is not a number, so max(-3, "x") is 0', () => {
    expect(evaluateExpression('min(3, "x")', {})).toBe(0)
    expect(evaluateExpression('max(-3, "x")', {})).toBe(0)
    expect(evaluateExpression('max(-3, x)', { x: null })).toBe(0)
  })

  it('compares two strings as text, even when both look like numbers', () => {
    expect(evaluatePredicate('"10" > "9"', {})).toBe(false)
    // 只要有一边是真正的数字，就按数值比
    expect(evaluatePredicate('10 > "9"', {})).toBe(true)
    expect(evaluatePredicate('x > "9"', { x: 10 })).toBe(true)
  })

  it('lets division by zero produce Infinity, which JSON would write as null', () => {
    expect(evaluateExpression('5 / 0', {})).toBe(Number.POSITIVE_INFINITY)
    expect(JSON.stringify({ value: evaluateExpression('5 / 0', {}) })).toBe('{"value":null}')
  })
})

describe('type errors', () => {
  const cases: [string, Context, RegExp][] = [
    ['x[1.5]', { x: [10, 20] }, /数组索引必须为整数/],
    ['x["a"]', { x: [10, 20] }, /数组索引必须为整数/],
    ['x.foo', { x: 'abcd' }, /字符串不支持字段/],
    ['x.foo', { x: null }, /无法读取/],
    ['x.foo', { x: 5 }, /无法读取/],
    // 继承来的属性不是规则能读的字段
    ['x.toString', { x: {} }, /未知字段/],
    ['x.hasOwnProperty', { x: {} }, /未知字段/],
    ['x[1]', { x: { a: 1 } }, /未知字段/],
    ['x.prototype', { x: {} }, /禁止访问字段/],
    ['x.__defineGetter__', { x: {} }, /禁止访问字段/],
    ['x + 1', { x: null }, /需要数值/],
    ['x + 1', { x: [] }, /需要数值/],
    ['x * 2', { x: 'abc' }, /需要数值/],
    ['"a" > 1', {}, /需要数值/],
    ['x > 1', { x: null }, /需要数值/],
  ]

  it.each(cases)('%s with %j is a type error', (source, context, message) => {
    const error = failure(source, context)
    expect(error.code).toBe('type')
    expect(error.message).toMatch(message)
  })
})

describe('string literals', () => {
  it.each([
    ['"a\\nb"', 'a\nb'],
    ['"a\\tb"', 'a\tb'],
    ['"a\\"b"', 'a"b'],
    ["'a\\'b'", "a'b"],
    ['"a\\\\b"', 'a\\b'],
  ])('decodes the escapes in %s', (source, expected) => {
    expect(evaluateExpression(source, {})).toBe(expected)
  })

  it.each(['"abc', "'abc", '"abc\\"'])('reports %s as unterminated, at the opening quote', (source) => {
    // 最后一例：末尾的 \" 是被转义的引号，字符串仍然没有闭合
    const error = failure(source)
    expect(error.message).toContain('字符串未闭合')
    expect(error.code).toBe('syntax')
    expect(error.position).toBe(0)
  })
})

describe('syntax errors', () => {
  const cases: [string, RegExp, number][] = [
    ['1 2', /多余的内容/, 2],
    ['(1', /缺少 "\)"/, 2],
    ['[1, 2', /缺少 "\]"/, 5],
    ['x["a"', /缺少 "\]"/, 5],
    ['len(', /意外的结尾/, 4],
    ['a.1', /"\." 后需要字段名/, 2],
    ['a.', /"\." 后需要字段名/, 2],
    ['@', /无法识别的字符/, 0],
    ['1 = 1', /无法识别的字符/, 2],
    ['a ? b : c', /无法识别的字符/, 2],
    ['   ', /表达式为空/, 0],
  ]

  it.each(cases)('%j fails with %s at position %i', (source, message, position) => {
    const error = capture(() => compileExpression(source))
    expect(error.message).toMatch(message)
    expect(error.code).toBe('syntax')
    expect(error.position).toBe(position)
  })
})

describe('limits', () => {
  const parens = (depth: number) => `${'('.repeat(depth)}1${')'.repeat(depth)}`
  const sum = (terms: number) => Array.from({ length: terms }, () => 'x').join(' + ')

  it('accepts nesting and size just inside the limits', () => {
    expect(evaluateExpression(parens(10), {})).toBe(1)
    expect(evaluateExpression(sum(100), { x: 1 })).toBe(100)
  })

  it.each([
    ['deeply nested parentheses', parens(60)],
    ['a long chain of !', `${'!'.repeat(100)}x`],
    ['a long chain of unary minus', `${'-'.repeat(100)}1`],
  ])('rejects %s as a limit error', (_name, source) => {
    expect(capture(() => compileExpression(source)).code).toBe('limit')
  })

  it('rejects too many nodes even when the source is short enough', () => {
    const error = capture(() => compileExpression(sum(220)))
    expect(error.code).toBe('limit')
    expect(error.message).toContain('过于复杂')
  })
})

describe('compile cache', () => {
  it('returns the same compiled expression for equivalent source, and stays correct after eviction', () => {
    const first = compileExpression('  len(x) > 1 ')
    expect(compileExpression('  len(x) > 1 ')).toBe(first) // 带空格的同一串也命中
    expect(compileExpression('len(x) > 1')).toBe(first)

    // 缓存有上限，满了会清空；清空之后重新编译的结果必须照样正确
    for (let index = 0; index < 600; index += 1) compileExpression(`${index} + 1`)

    expect(first.run({ x: [1, 2] })).toBe(true)
    expect(compileExpression('len(x) > 1').run({ x: [1] })).toBe(false)
  })
})
