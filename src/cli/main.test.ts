import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { EXIT, loadPack, main } from './main'
import { CLI_VERSION } from './version'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tqa-main-'))
  roots.push(dir)
  return dir
}

function trace(dir: string, name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

const CLEAN = JSON.stringify([
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元。' },
])

const BROKEN = JSON.stringify([
  { role: 'user', content: '改工单' },
  { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'update', arguments: '{"id":' } }] },
])

function capture() {
  const chunks: { out: string; err: string } = { out: '', err: '' }
  return {
    chunks,
    io: {
      out: (chunk: string) => {
        chunks.out += chunk
      },
      err: (chunk: string) => {
        chunks.err += chunk
      },
    },
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('main', () => {
  it('prints help and exits 0', () => {
    const { io, chunks } = capture()
    expect(main(['--help'], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('用法：')
  })

  it('prints the version and exits 0', () => {
    const { io, chunks } = capture()
    expect(main(['--version'], io)).toBe(EXIT.ok)
    expect(chunks.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('falls back to the real stdout when no io is injected', () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    try {
      expect(main(['--version'])).toBe(EXIT.ok)
    } finally {
      spy.mockRestore()
    }
    expect(written.join('')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects bad usage with exit 2 and a hint', () => {
    const { io, chunks } = capture()
    expect(main(['--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未知选项')
    expect(chunks.err).toContain('--help')
  })

  it('follows --locale for its own errors', () => {
    const { io, chunks } = capture()
    expect(main(['--locale', 'en', '--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('Unknown option')
  })

  it('reports a missing path', () => {
    const { io, chunks } = capture()
    expect(main([join(tempDir(), 'ghost.json')], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('路径不存在')
  })

  it('analyzes a directory and prints the table', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(main([dir], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('1 个文件')
    expect(chunks.out).toContain('A')
    expect(chunks.err).toBe('')
  })

  it('returns 1 when the gate fails, 0 when it passes', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)

    const failing = capture()
    expect(main([dir, '--fail-below', '90', '--quiet'], failing.io)).toBe(EXIT.gate)
    expect(failing.chunks.out).toContain('未通过')

    const passing = capture()
    expect(main([dir, '--fail-below', '10', '--quiet'], passing.io)).toBe(EXIT.ok)
  })

  it('writes the reports with --out and honours --format', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')

    const both = capture()
    expect(main([dir, '--out', out, '--quiet'], both.io)).toBe(EXIT.ok)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
    expect(existsSync(join(out, 'report.json'))).toBe(true)
    expect(both.chunks.out).toContain('已写出')

    const mdOnly = join(dir, 'md-only')
    expect(main([dir, '--out', mdOnly, '--format', 'md', '--quiet'], capture().io)).toBe(EXIT.ok)
    expect(existsSync(join(mdOnly, 'report.md'))).toBe(true)
    expect(existsSync(join(mdOnly, 'report.json'))).toBe(false)
  })

  it('exits 2 when the output directory cannot be created', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    // 把 --out 指向一个已存在的文件，mkdir 必然失败。
    const blocker = trace(dir, 'blocker.txt', 'x')
    const { io, chunks } = capture()

    expect(main([dir, '--out', blocker, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('refuses to report success when every file failed', () => {
    const dir = tempDir()
    trace(dir, 'bad.json', '{not json')
    const { io, chunks } = capture()

    // 「什么都没分析到」必须是 2：空跑通过比失败更危险。
    expect(main([dir], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未产出报告')
  })

  it('accepts a valid pack and rejects a broken one', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)

    const goodPack = join(dir, 'pack.json')
    writeFileSync(goodPack, JSON.stringify(DEFAULT_PACK))
    expect(main([dir, '--pack', goodPack, '--quiet'], capture().io)).toBe(EXIT.ok)

    const badPack = join(dir, 'bad-pack.json')
    writeFileSync(badPack, JSON.stringify({ ...DEFAULT_PACK, rules: [{ id: 'x' }] }))
    const broken = capture()
    expect(main([dir, '--pack', badPack, '--quiet'], broken.io)).toBe(EXIT.error)
    expect(broken.chunks.err).toContain('规则包校验失败')
  })

  it('reports an unreadable pack file', () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const missing = join(dir, 'no-pack.json')
    const { io, chunks } = capture()
    expect(main([dir, '--pack', missing, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('规则包校验失败')
  })
})

describe('loadPack', () => {
  it('parses the builtin pack round-trip', () => {
    const dir = tempDir()
    const path = join(dir, 'pack.json')
    writeFileSync(path, JSON.stringify(DEFAULT_PACK))
    const loaded = loadPack(path)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.pack.rules.length).toBe(DEFAULT_PACK.rules.length)
  })

  it('reports json syntax errors verbatim', () => {
    const dir = tempDir()
    const path = join(dir, 'pack.json')
    writeFileSync(path, '{oops')
    const loaded = loadPack(path)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.message.length).toBeGreaterThan(0)
  })
})

describe('cli contract', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
    bin: Record<string, string>
  }

  it('keeps the reported version in sync with package.json', () => {
    expect(CLI_VERSION).toBe(pkg.version)
  })

  it('points the bin entry at the built bundle', () => {
    expect(pkg.bin['trajectory-qa']).toBe('dist-cli/qa.mjs')
  })
})
