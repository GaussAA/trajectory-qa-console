/** A tiny, sandboxed expression language for rule predicates.
 *
 *  Rules are data — users can edit them in the UI — so we must never reach for
 *  `eval` / `new Function`: that would turn a pasted rule pack into code
 *  execution. This interpreter walks the string itself and only touches an
 *  explicit whitelist of functions and fields.
 *
 *  Grammar (precedence low → high):
 *    or   := and (("||" | "or") and)*
 *    and  := eq  (("&&" | "and") eq)*
 *    eq   := rel (("==" | "!=") rel)*
 *    rel  := add ((">" | ">=" | "<" | "<=") add)*
 *    add  := mul (("+" | "-") mul)*
 *    mul  := unary (("*" | "/" | "%") unary)*
 *    unary:= ("!" | "not") unary | postfix
 *    post := primary ("." ident | "[" or "]")*
 *    prim := number | string | true | false | null | ident | ident "(" args ")" | "(" or ")"
 */

export class ExprError extends Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(`${message}（位置 ${position}）`)
    this.name = 'ExprError'
    this.position = position
  }
}

type TokenType = 'number' | 'string' | 'ident' | 'op' | 'eof'

interface Token {
  type: TokenType
  value: string
  pos: number
}

const OPERATORS = [
  '&&',
  '||',
  '==',
  '!=',
  '>=',
  '<=',
  '>',
  '<',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
]

const BLOCKED_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i] as string

    if (/\s/.test(ch)) {
      i += 1
      continue
    }

    if (/[0-9]/.test(ch)) {
      const start = i
      while (i < src.length && /[0-9]/.test(src[i] as string)) i += 1
      if (src[i] === '.') {
        i += 1
        while (i < src.length && /[0-9]/.test(src[i] as string)) i += 1
      }
      tokens.push({ type: 'number', value: src.slice(start, i), pos: start })
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = i
      i += 1
      let out = ''
      let closed = false
      while (i < src.length) {
        const c = src[i] as string
        if (c === '\\') {
          const next = src[i + 1] ?? ''
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        if (c === quote) {
          i += 1
          closed = true
          break
        }
        out += c
        i += 1
      }
      if (!closed) throw new ExprError('字符串未闭合', start)
      tokens.push({ type: 'string', value: out, pos: start })
      continue
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i] as string)) i += 1
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start })
      continue
    }

    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i))
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i })
      i += op.length
      continue
    }

    throw new ExprError(`无法识别的字符 "${ch}"`, i)
  }

  tokens.push({ type: 'eof', value: '', pos: src.length })
  return tokens
}

export type ExprValue = unknown

export function truthy(value: ExprValue): boolean {
  if (value === null || value === undefined || value === false) return false
  if (value === 0 || value === '') return false
  if (typeof value === 'number' && Number.isNaN(value)) return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

function toNumber(value: ExprValue): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return undefined
}

function numeric(a: ExprValue, b: ExprValue, pos: number, op: string): [number, number] {
  const left = toNumber(a)
  const right = toNumber(b)
  if (left === undefined || right === undefined) {
    throw new ExprError(`运算符 ${op} 需要数值，收到 ${typeof a} 与 ${typeof b}`, pos)
  }
  return [left, right]
}

function looseEquals(a: ExprValue, b: ExprValue): boolean {
  if (a === b) return true
  const left = toNumber(a)
  const right = toNumber(b)
  if (left !== undefined && right !== undefined) return left === right
  return false
}

function getProperty(base: ExprValue, key: ExprValue, pos: number): ExprValue {
  if (typeof key === 'string' && BLOCKED_KEYS.has(key)) {
    throw new ExprError(`禁止访问字段 "${key}"`, pos)
  }

  if (Array.isArray(base)) {
    if (key === 'length') return base.length
    const index = typeof key === 'number' ? key : Number(key)
    if (!Number.isInteger(index)) throw new ExprError(`数组索引必须为整数，收到 "${String(key)}"`, pos)
    return base[index]
  }

  if (typeof base === 'string') {
    if (key === 'length') return base.length
    throw new ExprError(`字符串不支持字段 "${String(key)}"`, pos)
  }

  if (base !== null && typeof base === 'object') {
    const record = base as Record<string, ExprValue>
    const name = String(key)
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new ExprError(`未知字段 "${name}"`, pos)
    }
    return record[name]
  }

  throw new ExprError(`无法读取 ${String(base)} 的字段 "${String(key)}"`, pos)
}

const FUNCTIONS: Record<string, (args: ExprValue[], pos: number) => ExprValue> = {
  len: ([value]) => (Array.isArray(value) || typeof value === 'string' ? value.length : 0),
  includes: ([haystack, needle]) => {
    if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle))
    if (typeof haystack === 'string') return haystack.includes(String(needle))
    return false
  },
  any: ([list]) => (Array.isArray(list) ? list.some(truthy) : false),
  all: ([list]) => (Array.isArray(list) ? list.every(truthy) : false),
  count: ([list]) => (Array.isArray(list) ? list.filter(truthy).length : 0),
  sum: ([list]) =>
    Array.isArray(list)
      ? list.reduce<number>((acc, item) => acc + (toNumber(item) ?? 0), 0)
      : 0,
  round: ([value, digits]) => {
    const n = toNumber(value) ?? 0
    const d = toNumber(digits) ?? 0
    const factor = 10 ** Math.max(0, Math.min(6, Math.trunc(d)))
    return Math.round(n * factor) / factor
  },
  floor: ([value]) => Math.floor(toNumber(value) ?? 0),
  ceil: ([value]) => Math.ceil(toNumber(value) ?? 0),
  abs: ([value]) => Math.abs(toNumber(value) ?? 0),
  min: ([a, b]) => Math.min(toNumber(a) ?? 0, toNumber(b) ?? 0),
  max: ([a, b]) => Math.max(toNumber(a) ?? 0, toNumber(b) ?? 0),
  lower: ([value]) => String(value ?? '').toLowerCase(),
  upper: ([value]) => String(value ?? '').toUpperCase(),
  startsWith: ([value, prefix]) => String(value ?? '').startsWith(String(prefix ?? '')),
  endsWith: ([value, suffix]) => String(value ?? '').endsWith(String(suffix ?? '')),
}

class Parser {
  private cursor = 0

  constructor(
    private readonly tokens: Token[],
    private readonly context: Record<string, ExprValue>,
  ) {}

  parse(): ExprValue {
    const value = this.parseOr()
    const token = this.peek()
    if (token.type !== 'eof') {
      throw new ExprError(`多余的内容 "${token.value}"`, token.pos)
    }
    return value
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)] as Token
  }

  private next(): Token {
    const token = this.peek()
    this.cursor += 1
    return token
  }

  private matchOp(...ops: string[]): Token | undefined {
    const token = this.peek()
    if (token.type === 'op' && ops.includes(token.value)) {
      this.cursor += 1
      return token
    }
    return undefined
  }

  private matchKeyword(...words: string[]): Token | undefined {
    const token = this.peek()
    if (token.type === 'ident' && words.includes(token.value)) {
      this.cursor += 1
      return token
    }
    return undefined
  }

  private expectOp(op: string): Token {
    const token = this.matchOp(op)
    if (!token) throw new ExprError(`缺少 "${op}"`, this.peek().pos)
    return token
  }

  private parseOr(): ExprValue {
    let left = this.parseAnd()
    while (this.matchOp('||') ?? this.matchKeyword('or')) {
      const right = this.parseAnd()
      left = truthy(left) ? left : right
    }
    return left
  }

  private parseAnd(): ExprValue {
    let left = this.parseEquality()
    while (this.matchOp('&&') ?? this.matchKeyword('and')) {
      const right = this.parseEquality()
      left = truthy(left) ? right : left
    }
    return left
  }

  private parseEquality(): ExprValue {
    let left = this.parseRelational()
    for (;;) {
      const op = this.matchOp('==', '!=')
      if (!op) return left
      const right = this.parseRelational()
      left = op.value === '==' ? looseEquals(left, right) : !looseEquals(left, right)
    }
  }

  private parseRelational(): ExprValue {
    let left = this.parseAdditive()
    for (;;) {
      const op = this.matchOp('>', '>=', '<', '<=')
      if (!op) return left
      const right = this.parseAdditive()
      let result: boolean
      if (typeof left === 'string' && typeof right === 'string') {
        result =
          op.value === '>'
            ? left > right
            : op.value === '>='
              ? left >= right
              : op.value === '<'
                ? left < right
                : left <= right
      } else {
        const [a, b] = numeric(left, right, op.pos, op.value)
        result =
          op.value === '>' ? a > b : op.value === '>=' ? a >= b : op.value === '<' ? a < b : a <= b
      }
      left = result
    }
  }

  private parseAdditive(): ExprValue {
    let left = this.parseMultiplicative()
    for (;;) {
      const op = this.matchOp('+', '-')
      if (!op) return left
      const right = this.parseMultiplicative()
      if (op.value === '+') {
        if (typeof left === 'number' && typeof right === 'number') left += right
        else if (typeof left === 'string' || typeof right === 'string') left = `${String(left)}${String(right)}`
        else {
          const [a, b] = numeric(left, right, op.pos, '+')
          left = a + b
        }
      } else {
        const [a, b] = numeric(left, right, op.pos, '-')
        left = a - b
      }
    }
  }

  private parseMultiplicative(): ExprValue {
    let left = this.parseUnary()
    for (;;) {
      const op = this.matchOp('*', '/', '%')
      if (!op) return left
      const right = this.parseUnary()
      const [a, b] = numeric(left, right, op.pos, op.value)
      left = op.value === '*' ? a * b : op.value === '/' ? a / b : a % b
    }
  }

  private parseUnary(): ExprValue {
    if (this.matchOp('!') ?? this.matchKeyword('not')) {
      return !truthy(this.parseUnary())
    }
    if (this.matchOp('-')) {
      return -(toNumber(this.parseUnary()) ?? 0)
    }
    return this.parsePostfix()
  }

  private parsePostfix(): ExprValue {
    let value = this.parsePrimary()
    for (;;) {
      const dot = this.matchOp('.')
      if (dot) {
        const key = this.next()
        if (key.type !== 'ident') throw new ExprError('"." 后需要字段名', key.pos)
        value = getProperty(value, key.value, key.pos)
        continue
      }
      const bracket = this.matchOp('[')
      if (bracket) {
        const key = this.parseOr()
        this.expectOp(']')
        value = getProperty(value, key, bracket.pos)
        continue
      }
      return value
    }
  }

  private parsePrimary(): ExprValue {
    const token = this.peek()

    if (token.type === 'number') {
      this.next()
      return Number(token.value)
    }

    if (token.type === 'string') {
      this.next()
      return token.value
    }

    if (token.type === 'op' && token.value === '(') {
      this.next()
      const value = this.parseOr()
      this.expectOp(')')
      return value
    }

    if (token.type === 'op' && token.value === '[') {
      this.next()
      const items: ExprValue[] = []
      if (!this.matchOp(']')) {
        for (;;) {
          items.push(this.parseOr())
          if (this.matchOp(',')) continue
          this.expectOp(']')
          break
        }
      }
      return items
    }

    if (token.type === 'ident') {
      this.next()

      if (token.value === 'true') return true
      if (token.value === 'false') return false
      if (token.value === 'null') return null

      const fn = FUNCTIONS[token.value]
      if (fn && this.matchOp('(')) {
        const args: ExprValue[] = []
        if (!this.matchOp(')')) {
          for (;;) {
            args.push(this.parseOr())
            if (this.matchOp(',')) continue
            this.expectOp(')')
            break
          }
        }
        return fn(args, token.pos)
      }

      if (!Object.prototype.hasOwnProperty.call(this.context, token.value)) {
        throw new ExprError(`未知标识符 "${token.value}"`, token.pos)
      }
      return this.context[token.value]
    }

    throw new ExprError(`意外的结尾`, token.pos)
  }
}

export function evaluateExpression(source: string, context: Record<string, ExprValue>): ExprValue {
  if (!source.trim()) throw new ExprError('表达式为空', 0)
  return new Parser(tokenize(source), context).parse()
}

export function evaluatePredicate(source: string, context: Record<string, ExprValue>): boolean {
  return truthy(evaluateExpression(source, context))
}

export const EXPR_FUNCTION_NAMES = Object.keys(FUNCTIONS)
