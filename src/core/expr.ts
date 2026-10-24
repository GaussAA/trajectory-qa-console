/** A small expression language for rule predicates, compiled then evaluated.
 *
 *  Rules are data — users edit them in the UI and import packs from disk — so we
 *  must never reach for `eval` / `new Function`. Compiling to an AST gives us
 *  three things an evaluator-only design cannot:
 *    1. syntax/unknown-function errors surface at *validation* time, not when a
 *       particular trace happens to hit the rule;
 *    2. the set of referenced fields is known statically, so the rule contract
 *       can reject typos ("unknown field") with the legal list in hand;
 *    3. evaluation is a pure tree walk with explicit limits — no parser state.
 *
 *  Grammar (precedence low → high):
 *    or   := and (("||" | "or") and)*
 *    and  := eq  (("&&" | "and") eq)*
 *    eq   := rel (("==" | "!=") rel)*
 *    rel  := add ((">" | ">=" | "<" | "<=") add)*
 *    add  := mul (("+" | "-") mul)*
 *    mul  := unary (("*" | "/" | "%") unary)*
 *    unary:= ("!" | "not") unary | "-" unary | postfix
 *    post := primary ("." ident | "[" or "]")*
 *    prim := number | string | true | false | null | ident
 *          | ident "(" args ")" | "(" or ")" | "[" items "]"
 */

export type ExprValue = unknown
export type ExprContext = Record<string, ExprValue>

export type ExprErrorCode = 'syntax' | 'unknown-identifier' | 'unknown-function' | 'type' | 'limit'

export class ExprError extends Error {
  readonly position: number
  readonly code: ExprErrorCode

  constructor(message: string, position: number, code: ExprErrorCode = 'syntax') {
    super(`${message}（位置 ${position}）`)
    this.name = 'ExprError'
    this.code = code
    this.position = position
  }
}

// ---------- tokenizer ----------

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

const MAX_SOURCE_LENGTH = 1000
const MAX_NODES = 400
const MAX_DEPTH = 40

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

// ---------- AST ----------

type Node =
  | { type: 'literal'; value: ExprValue }
  | { type: 'ident'; name: string; pos: number }
  | { type: 'unary'; op: '!' | '-'; operand: Node; pos: number }
  | { type: 'binary'; op: string; left: Node; right: Node; pos: number }
  | { type: 'member'; object: Node; property: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }
  | { type: 'array'; items: Node[] }

// ---------- functions ----------

interface FunctionSpec {
  name: string
  signature: string
  description: string
  call: (args: ExprValue[], pos: number) => ExprValue
}

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
    throw new ExprError(`运算符 ${op} 需要数值，收到 ${typeof a} 与 ${typeof b}`, pos, 'type')
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

const FUNCTIONS: Record<string, FunctionSpec> = {
  len: {
    name: 'len',
    signature: 'len(value)',
    description: '字符串或数组的长度',
    call: ([value]) => (Array.isArray(value) || typeof value === 'string' ? value.length : 0),
  },
  includes: {
    name: 'includes',
    signature: 'includes(list, value)',
    description: '数组或字符串是否包含某值',
    call: ([haystack, needle]) => {
      if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle))
      if (typeof haystack === 'string') return haystack.includes(String(needle))
      return false
    },
  },
  any: {
    name: 'any',
    signature: 'any(list)',
    description: '数组中是否存在真值',
    call: ([list]) => (Array.isArray(list) ? list.some(truthy) : false),
  },
  all: {
    name: 'all',
    signature: 'all(list)',
    description: '数组是否全为真值',
    call: ([list]) => (Array.isArray(list) ? list.every(truthy) : false),
  },
  count: {
    name: 'count',
    signature: 'count(list)',
    description: '数组中真值个数',
    call: ([list]) => (Array.isArray(list) ? list.filter(truthy).length : 0),
  },
  sum: {
    name: 'sum',
    signature: 'sum(list)',
    description: '数值数组求和',
    call: ([list]) =>
      Array.isArray(list) ? list.reduce<number>((acc, item) => acc + (toNumber(item) ?? 0), 0) : 0,
  },
  round: {
    name: 'round',
    signature: 'round(value[, digits])',
    description: '四舍五入到指定小数位',
    call: ([value, digits]) => {
      const n = toNumber(value) ?? 0
      const d = toNumber(digits) ?? 0
      const factor = 10 ** Math.max(0, Math.min(6, Math.trunc(d)))
      return Math.round(n * factor) / factor
    },
  },
  floor: {
    name: 'floor',
    signature: 'floor(value)',
    description: '向下取整',
    call: ([value]) => Math.floor(toNumber(value) ?? 0),
  },
  ceil: {
    name: 'ceil',
    signature: 'ceil(value)',
    description: '向上取整',
    call: ([value]) => Math.ceil(toNumber(value) ?? 0),
  },
  abs: {
    name: 'abs',
    signature: 'abs(value)',
    description: '绝对值',
    call: ([value]) => Math.abs(toNumber(value) ?? 0),
  },
  min: {
    name: 'min',
    signature: 'min(a, b)',
    description: '较小值',
    call: ([a, b]) => Math.min(toNumber(a) ?? 0, toNumber(b) ?? 0),
  },
  max: {
    name: 'max',
    signature: 'max(a, b)',
    description: '较大值',
    call: ([a, b]) => Math.max(toNumber(a) ?? 0, toNumber(b) ?? 0),
  },
  lower: {
    name: 'lower',
    signature: 'lower(text)',
    description: '转小写',
    call: ([value]) => String(value ?? '').toLowerCase(),
  },
  upper: {
    name: 'upper',
    signature: 'upper(text)',
    description: '转大写',
    call: ([value]) => String(value ?? '').toUpperCase(),
  },
  startsWith: {
    name: 'startsWith',
    signature: 'startsWith(text, prefix)',
    description: '前缀判断',
    call: ([value, prefix]) => String(value ?? '').startsWith(String(prefix ?? '')),
  },
  endsWith: {
    name: 'endsWith',
    signature: 'endsWith(text, suffix)',
    description: '后缀判断',
    call: ([value, suffix]) => String(value ?? '').endsWith(String(suffix ?? '')),
  },
}

export const EXPR_FUNCTIONS: readonly Pick<FunctionSpec, 'name' | 'signature' | 'description'>[] =
  Object.values(FUNCTIONS).map(({ name, signature, description }) => ({ name, signature, description }))

// ---------- parser ----------

class Parser {
  private cursor = 0
  private nodes = 0
  private depth = 0
  private readonly identifiers = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parse(): { root: Node; identifiers: string[] } {
    const root = this.parseOr()
    const token = this.peek()
    if (token.type !== 'eof') throw new ExprError(`多余的内容 "${token.value}"`, token.pos)
    return { root, identifiers: [...this.identifiers] }
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)] as Token
  }

  private next(): Token {
    const token = this.peek()
    this.cursor += 1
    return token
  }

  private count(): void {
    this.nodes += 1
    if (this.nodes > MAX_NODES) {
      throw new ExprError(`表达式过于复杂（节点上限 ${MAX_NODES}）`, this.peek().pos, 'limit')
    }
  }

  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_DEPTH) {
      throw new ExprError(`表达式嵌套过深（上限 ${MAX_DEPTH}）`, this.peek().pos, 'limit')
    }
  }

  private leave(): void {
    this.depth -= 1
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

  private parseOr(): Node {
    this.enter()
    let left = this.parseAnd()
    for (;;) {
      const token = this.matchOp('||') ?? this.matchKeyword('or')
      if (!token) break
      const right = this.parseAnd()
      left = { type: 'binary', op: '||', left, right, pos: token.pos }
      this.count()
    }
    this.leave()
    return left
  }

  private parseAnd(): Node {
    let left = this.parseEquality()
    for (;;) {
      const token = this.matchOp('&&') ?? this.matchKeyword('and')
      if (!token) break
      const right = this.parseEquality()
      left = { type: 'binary', op: '&&', left, right, pos: token.pos }
      this.count()
    }
    return left
  }

  private parseEquality(): Node {
    let left = this.parseRelational()
    for (;;) {
      const token = this.matchOp('==', '!=')
      if (!token) return left
      const right = this.parseRelational()
      left = { type: 'binary', op: token.value, left, right, pos: token.pos }
      this.count()
    }
  }

  private parseRelational(): Node {
    const left = this.parseAdditive()
    const token = this.matchOp('>', '>=', '<', '<=')
    if (!token) return left
    const right = this.parseAdditive()
    // 不支持连续比较：`10 < x < 40` 会按左结合算成 `(10 < x) < 40`，布尔被当成 0/1 再去比 40，
    // 于是 x 是 100 和 5 时结果都是 true。看着对、算得错，比报错更糟。
    const chained = this.peek()
    if (chained.type === 'op' && ['>', '>=', '<', '<='].includes(chained.value)) {
      throw new ExprError(
        `不支持连续比较 "${chained.value}"：请拆成两个比较并用 and 连接，例如 a > 10 and a < 40`,
        chained.pos,
      )
    }
    this.count()
    return { type: 'binary', op: token.value, left, right, pos: token.pos }
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative()
    for (;;) {
      const token = this.matchOp('+', '-')
      if (!token) return left
      const right = this.parseMultiplicative()
      left = { type: 'binary', op: token.value, left, right, pos: token.pos }
      this.count()
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary()
    for (;;) {
      const token = this.matchOp('*', '/', '%')
      if (!token) return left
      const right = this.parseUnary()
      left = { type: 'binary', op: token.value, left, right, pos: token.pos }
      this.count()
    }
  }

  private parseUnary(): Node {
    this.enter()
    const notToken = this.matchOp('!') ?? this.matchKeyword('not')
    if (notToken) {
      const node: Node = { type: 'unary', op: '!', operand: this.parseUnary(), pos: notToken.pos }
      this.count()
      this.leave()
      return node
    }
    const minus = this.matchOp('-')
    if (minus) {
      const node: Node = { type: 'unary', op: '-', operand: this.parseUnary(), pos: minus.pos }
      this.count()
      this.leave()
      return node
    }
    const node = this.parsePostfix()
    this.leave()
    return node
  }

  private parsePostfix(): Node {
    let value = this.parsePrimary()
    for (;;) {
      const dot = this.matchOp('.')
      if (dot) {
        const key = this.next()
        if (key.type !== 'ident') throw new ExprError('"." 后需要字段名', key.pos)
        value = {
          type: 'member',
          object: value,
          property: { type: 'literal', value: key.value },
          pos: key.pos,
        }
        this.count()
        continue
      }
      const bracket = this.matchOp('[')
      if (bracket) {
        const property = this.parseOr()
        this.expectOp(']')
        value = { type: 'member', object: value, property, pos: bracket.pos }
        this.count()
        continue
      }
      return value
    }
  }

  private parsePrimary(): Node {
    const token = this.peek()

    if (token.type === 'number') {
      this.next()
      return { type: 'literal', value: Number(token.value) }
    }

    if (token.type === 'string') {
      this.next()
      return { type: 'literal', value: token.value }
    }

    if (token.type === 'op' && token.value === '(') {
      this.next()
      const value = this.parseOr()
      this.expectOp(')')
      return value
    }

    if (token.type === 'op' && token.value === '[') {
      this.next()
      const items: Node[] = []
      if (!this.matchOp(']')) {
        for (;;) {
          items.push(this.parseOr())
          if (this.matchOp(',')) continue
          this.expectOp(']')
          break
        }
      }
      this.count()
      return { type: 'array', items }
    }

    if (token.type === 'ident') {
      this.next()

      if (token.value === 'true') return { type: 'literal', value: true }
      if (token.value === 'false') return { type: 'literal', value: false }
      if (token.value === 'null') return { type: 'literal', value: null }

      if (
        Object.prototype.hasOwnProperty.call(FUNCTIONS, token.value) &&
        this.peek().type === 'op' &&
        this.peek().value === '('
      ) {
        this.next()
        const args: Node[] = []
        if (!this.matchOp(')')) {
          for (;;) {
            args.push(this.parseOr())
            if (this.matchOp(',')) continue
            this.expectOp(')')
            break
          }
        }
        this.count()
        return { type: 'call', name: token.value, args, pos: token.pos }
      }

      this.identifiers.add(token.value)
      this.count()
      return { type: 'ident', name: token.value, pos: token.pos }
    }

    throw new ExprError('意外的结尾', token.pos)
  }
}

// ---------- evaluator ----------

function getProperty(base: ExprValue, key: ExprValue, pos: number): ExprValue {
  if (typeof key === 'string' && BLOCKED_KEYS.has(key)) {
    throw new ExprError(`禁止访问字段 "${key}"`, pos, 'type')
  }

  if (Array.isArray(base)) {
    if (key === 'length') return base.length
    const index = typeof key === 'number' ? key : Number(key)
    if (!Number.isInteger(index)) {
      throw new ExprError(`数组索引必须为整数，收到 "${String(key)}"`, pos, 'type')
    }
    return base[index]
  }

  if (typeof base === 'string') {
    if (key === 'length') return base.length
    throw new ExprError(`字符串不支持字段 "${String(key)}"`, pos, 'type')
  }

  if (base !== null && typeof base === 'object') {
    const record = base as Record<string, ExprValue>
    const name = String(key)
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new ExprError(`未知字段 "${name}"`, pos, 'type')
    }
    return record[name]
  }

  throw new ExprError(`无法读取 ${String(base)} 的字段 "${String(key)}"`, pos, 'type')
}

function evaluateNode(node: Node, context: ExprContext): ExprValue {
  switch (node.type) {
    case 'literal':
      return node.value

    case 'array':
      return node.items.map((item) => evaluateNode(item, context))

    case 'ident':
      if (!Object.prototype.hasOwnProperty.call(context, node.name)) {
        throw new ExprError(`未知标识符 "${node.name}"`, node.pos, 'unknown-identifier')
      }
      return context[node.name]

    case 'member':
      return getProperty(evaluateNode(node.object, context), evaluateNode(node.property, context), node.pos)

    case 'call': {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new ExprError(`未知函数 "${node.name}"`, node.pos, 'unknown-function')
      return fn.call(
        node.args.map((arg) => evaluateNode(arg, context)),
        node.pos,
      )
    }

    case 'unary': {
      const value = evaluateNode(node.operand, context)
      if (node.op === '!') return !truthy(value)
      return -(toNumber(value) ?? 0)
    }

    case 'binary': {
      if (node.op === '&&') {
        const left = evaluateNode(node.left, context)
        return truthy(left) ? evaluateNode(node.right, context) : left
      }
      if (node.op === '||') {
        const left = evaluateNode(node.left, context)
        return truthy(left) ? left : evaluateNode(node.right, context)
      }

      const left = evaluateNode(node.left, context)
      const right = evaluateNode(node.right, context)

      switch (node.op) {
        case '==':
          return looseEquals(left, right)
        case '!=':
          return !looseEquals(left, right)
        case '>':
        case '>=':
        case '<':
        case '<=': {
          if (typeof left === 'string' && typeof right === 'string') {
            if (node.op === '>') return left > right
            if (node.op === '>=') return left >= right
            if (node.op === '<') return left < right
            return left <= right
          }
          const [a, b] = numeric(left, right, node.pos, node.op)
          if (node.op === '>') return a > b
          if (node.op === '>=') return a >= b
          if (node.op === '<') return a < b
          return a <= b
        }
        case '+':
          if (typeof left === 'number' && typeof right === 'number') return left + right
          if (typeof left === 'string' || typeof right === 'string') return `${String(left)}${String(right)}`
          return numeric(left, right, node.pos, '+').reduce((a, b) => a + b, 0)
        case '-':
          return numeric(left, right, node.pos, '-').reduce((a, b) => a - b)
        case '*':
          return numeric(left, right, node.pos, '*').reduce((a, b) => a * b)
        case '/':
          return numeric(left, right, node.pos, '/').reduce((a, b) => a / b)
        case '%':
          return numeric(left, right, node.pos, '%').reduce((a, b) => a % b)
        default:
          throw new ExprError(`未知运算符 "${node.op}"`, node.pos)
      }
    }

    default:
      throw new ExprError('未知表达式节点', 0)
  }
}

// ---------- public API ----------

export interface CompiledExpression {
  readonly source: string
  /** Top-level identifiers the expression reads from the context. */
  readonly identifiers: readonly string[]
  run(context: ExprContext): ExprValue
}

const cache = new Map<string, CompiledExpression>()
const CACHE_LIMIT = 500

export function compileExpression(source: string): CompiledExpression {
  const trimmed = source.trim()
  if (!trimmed) throw new ExprError('表达式为空', 0)
  if (trimmed.length > MAX_SOURCE_LENGTH) {
    throw new ExprError(`表达式过长（上限 ${MAX_SOURCE_LENGTH} 字符）`, 0, 'limit')
  }

  const cached = cache.get(trimmed)
  if (cached) return cached

  const { root, identifiers } = new Parser(tokenize(trimmed)).parse()
  const compiled: CompiledExpression = {
    source: trimmed,
    identifiers,
    run: (context) => evaluateNode(root, context),
  }

  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(trimmed, compiled)
  return compiled
}

export function evaluateExpression(source: string, context: ExprContext): ExprValue {
  return compileExpression(source).run(context)
}

export function evaluatePredicate(source: string, context: ExprContext): boolean {
  return truthy(evaluateExpression(source, context))
}
