/** CLI 主流程：参数、报告产物、门禁与退出码、规则包加载、对外契约。
 *  --compare、语义复核、智能体诊断、serve 与 --llm-timeout 见同目录的 main.*.test.ts。 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { BUILTIN_PACK_EN } from '../core/rules/builtin-pack-en'
import { EXIT, loadPack, main, resolvePackAlias } from './main'
import { BROKEN, CLEAN, capture, cleanupTempDirs, tempDir, trace } from './test-support'
import { CLI_VERSION } from './version'

afterEach(cleanupTempDirs)

describe('main', () => {
  it('prints help and exits 0', async () => {
    const { io, chunks } = capture()
    expect(await main(['--help'], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('用法：')
  })

  it('prints the version and exits 0', async () => {
    const { io, chunks } = capture()
    expect(await main(['--version'], io)).toBe(EXIT.ok)
    expect(chunks.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('falls back to the real stdout when no io is injected', async () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    try {
      expect(await main(['--version'])).toBe(EXIT.ok)
    } finally {
      spy.mockRestore()
    }
    expect(written.join('')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects bad usage with exit 2 and a hint', async () => {
    const { io, chunks } = capture()
    expect(await main(['--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未知选项')
    expect(chunks.err).toContain('--help')
  })

  it('follows --locale for its own errors', async () => {
    const { io, chunks } = capture()
    expect(await main(['--locale', 'en', '--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('Unknown option')
  })

  it('reports a missing path', async () => {
    const { io, chunks } = capture()
    expect(await main([join(tempDir(), 'ghost.json')], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('路径不存在')
  })

  it('analyzes a directory and prints the table', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('1 个文件')
    expect(chunks.out).toContain('A')
    expect(chunks.err).toBe('')
  })

  it('returns 1 when the gate fails, 0 when it passes', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)

    const failing = capture()
    expect(await main([dir, '--fail-below', '90', '--quiet'], failing.io)).toBe(EXIT.gate)
    expect(failing.chunks.out).toContain('未通过')

    const passing = capture()
    expect(await main([dir, '--fail-below', '10', '--quiet'], passing.io)).toBe(EXIT.ok)
  })

  it('writes the reports with --out and honours --format', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    // 产物目录放在被扫描目录之外：否则上一轮的 report.json 会被当成轨迹
    // 再解析一遍（扩展名相同），这正是「部分失败」要防的自污染。
    const out = tempDir()

    const both = capture()
    expect(await main([dir, '--out', out, '--quiet'], both.io)).toBe(EXIT.ok)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
    expect(existsSync(join(out, 'report.json'))).toBe(true)
    expect(both.chunks.out).toContain('已写出')

    const mdOnly = tempDir()
    expect(await main([dir, '--out', mdOnly, '--format', 'md', '--quiet'], capture().io)).toBe(EXIT.ok)
    expect(existsSync(join(mdOnly, 'report.md'))).toBe(true)
    expect(existsSync(join(mdOnly, 'report.json'))).toBe(false)
  })

  it('writes a single self-contained HTML report with --format html', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)
    const out = join(dir, 'html-only')
    const { io, chunks } = capture()

    expect(await main([dir, '--out', out, '--format', 'html', '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'report.html'))).toBe(true)
    // html 是「只出这一份」，不该顺手再写 md/json
    expect(existsSync(join(out, 'report.md'))).toBe(false)
    expect(existsSync(join(out, 'report.json'))).toBe(false)

    const html = readFileSync(join(out, 'report.html'), 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('轨迹质检报告')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(chunks.out).toContain('report.html')
  })

  it('writes all three artifacts with --format all', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'all')

    expect(await main([dir, '--out', out, '--format', 'all', '--quiet'], capture().io)).toBe(EXIT.ok)
    for (const name of ['report.md', 'report.json', 'report.html']) {
      expect(existsSync(join(out, name))).toBe(true)
    }
  })

  it('compares the active pack against another with --pack-compare', async () => {
    const dir = tempDir()
    trace(dir, 'single.json', CLEAN)
    const out = join(dir, 'pk')
    const { io, chunks } = capture()

    expect(await main([dir, '--pack-compare', 'en', '--out', out, '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'pack-compare.md'))).toBe(true)
    expect(existsSync(join(out, 'pack-compare.json'))).toBe(true)
    const markdown = readFileSync(join(out, 'pack-compare.md'), 'utf8')
    expect(markdown).toContain('# 口径对比报告')
    expect(markdown).toContain('| 会话 | 基准 | 对照 | 变化 |')
    expect(chunks.out).toContain('口径对比：')
  })

  it('rejects combining --pack-compare with --compare', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--compare', '--pack-compare', 'en'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('不能同时使用')
  })

  it('rejects conflicting modes before spending any LLM budget', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const calls: unknown[] = []
    const { io, chunks } = capture()

    // The conflict used to be reported only after runBatch had already called
    // the model — the user paid for their own usage error.
    const code = await main(
      [
        dir,
        '--compare',
        '--pack-compare',
        'en',
        '--semantic',
        '--llm-url',
        'https://llm.example/v1',
        '--llm-model',
        'm',
      ],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k-123' },
        transport: async (request) => {
          calls.push(request)
          // 内容无关紧要：这个用例断言的是它根本不该被调用。
          return { ok: true, status: 200, text: '{}' }
        },
      },
    )

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('不能同时使用')
    expect(calls).toHaveLength(0)
  })

  it('writes an HTML comparison with --compare --format html', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const out = join(dir, 'cmp-html')
    const { io, chunks } = capture()

    expect(await main([dir, '--compare', '--format', 'html', '--out', out, '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'compare.html'))).toBe(true)
    expect(existsSync(join(out, 'compare.md'))).toBe(false)
    const html = readFileSync(join(out, 'compare.html'), 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('轨迹对比报告')
    expect(html).not.toMatch(/<script/i)
    expect(chunks.out).toContain('compare.html')
  })

  it('exits 2 when the output directory cannot be created', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    // 把 --out 指向一个已存在的文件，mkdir 必然失败。放在扫描目录之外，
    // 免得它自己先被当成轨迹解析失败，把写入错误盖掉。
    const blocker = trace(tempDir(), 'blocker.txt', 'x')
    const { io, chunks } = capture()

    expect(await main([dir, '--out', blocker, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('refuses to report success when every file failed', async () => {
    const dir = tempDir()
    trace(dir, 'bad.json', '{not json')
    const { io, chunks } = capture()

    // 「什么都没分析到」必须是 2：空跑通过比失败更危险。
    expect(await main([dir], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未产出报告')
  })

  it('refuses to pass the gate when only some files could be analysed', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', '{not json')
    const { io, chunks } = capture()

    // 有一条成功也不算通过：没检查过的那部分不能被算进「通过」。
    // 这是「空跑必须是 2」的另一半——此前只堵住了全空，漏掉了部分失败。
    expect(await main([dir, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未能分析')
  })

  it('accepts a valid pack and rejects a broken one', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)

    // 规则包放在扫描目录之外：它同样是 .json，留在里面会被当轨迹解析。
    const goodPack = join(tempDir(), 'pack.json')
    writeFileSync(goodPack, JSON.stringify(DEFAULT_PACK))
    expect(await main([dir, '--pack', goodPack, '--quiet'], capture().io)).toBe(EXIT.ok)

    const badPack = join(tempDir(), 'bad-pack.json')
    writeFileSync(badPack, JSON.stringify({ ...DEFAULT_PACK, rules: [{ id: 'x' }] }))
    const broken = capture()
    expect(await main([dir, '--pack', badPack, '--quiet'], broken.io)).toBe(EXIT.error)
    expect(broken.chunks.err).toContain('规则包校验失败')
  })

  it('resolves builtin pack aliases case-insensitively', async () => {
    expect(resolvePackAlias('en')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('  EN ')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('builtin-en')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('zh')?.name).toBe(DEFAULT_PACK.name)
    expect(resolvePackAlias('nope')).toBeNull()
  })

  it('produces a fully English report with --pack en --locale en', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)
    const out = join(dir, 'out')

    expect(await main([dir, '--pack', 'en', '--locale', 'en', '--out', out, '--quiet'], capture().io)).toBe(
      EXIT.ok,
    )

    const markdown = readFileSync(join(out, 'report.md'), 'utf8')
    expect(markdown).toContain('# Trajectory QA Report')
    expect(markdown).toContain('Builtin pack · EN v1')
    expect(markdown).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('reports an unreadable pack file', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const missing = join(dir, 'no-pack.json')
    const { io, chunks } = capture()
    expect(await main([dir, '--pack', missing, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('规则包校验失败')
  })
})

describe('an unwritable --out is an error message, not a stack trace', () => {
  function blockedOut(dir: string): string {
    // 把 --out 指到一个已存在的**文件**上：mkdir 必然失败。
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    return join(blocker, 'sub')
  }

  it('in the plain report branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()
    const input = join(dir, 'a.json')
    expect(await main([input, '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('in the --compare branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const { io, chunks } = capture()
    expect(await main([join(dir, 'a.json'), join(dir, 'b.json'), '--compare', '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('in the --pack-compare branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()
    expect(await main([join(dir, 'a.json'), '--pack-compare', 'en', '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })
})

describe('loadPack', () => {
  it('parses the builtin pack round-trip', async () => {
    const dir = tempDir()
    const path = join(dir, 'pack.json')
    writeFileSync(path, JSON.stringify(DEFAULT_PACK))
    const loaded = loadPack(path)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.pack.rules.length).toBe(DEFAULT_PACK.rules.length)
  })

  it('reports json syntax errors verbatim', async () => {
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

  it('keeps the reported version in sync with package.json', async () => {
    expect(CLI_VERSION).toBe(pkg.version)
  })

  it('points the bin entry at the built bundle', async () => {
    expect(pkg.bin['trajectory-qa']).toBe('dist-cli/qa.mjs')
  })
})
