import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectFiles, isInside } from './collect'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tqa-collect-'))
  roots.push(dir)
  return dir
}

function touch(dir: string, name: string, content = '{}'): string {
  const path = join(dir, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('collectFiles', () => {
  it('walks directories recursively in sorted order', () => {
    const root = tempRoot()
    touch(root, 'b.json')
    touch(root, 'a.jsonl')
    touch(root, 'nested/c.txt')

    const result = collectFiles([root], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)
    expect(result.value.files.map((file) => file.split(/[\\/]/).pop())).toEqual([
      'a.jsonl',
      'b.json',
      'c.txt',
    ])
  })

  it('skips dependency, build and hidden directories', () => {
    const root = tempRoot()
    touch(root, 'keep.json')
    touch(root, 'node_modules/ignored.json')
    touch(root, 'dist/ignored.json')
    touch(root, '.workbuddy/ignored.json')

    const result = collectFiles([root], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)
    expect(result.value.files).toHaveLength(1)
    expect(result.value.files[0]).toContain('keep.json')
  })

  it('refuses to follow a symlink out of the scanned root', (ctx) => {
    const root = tempRoot()
    const outside = tempRoot()
    touch(root, 'keep.json')
    touch(outside, 'secret.json', '{"role":"user"}')
    const linked = join(root, 'linked.json')
    try {
      symlinkSync(join(outside, 'secret.json'), linked)
    } catch {
      // 显式跳过而不是静默通过：否则无权限的环境会让这个用例假装绿。
      ctx.skip()
      return
    }

    const result = collectFiles([root], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)

    expect(result.value.files.map((file) => file.split(/[\\/]/).pop())).toEqual(['keep.json'])
    expect(result.value.skipped).toContainEqual({ path: linked, reason: 'outside-root' })
  })

  it('does not walk into a symlinked directory that leads outside the root', (ctx) => {
    const root = tempRoot()
    const outside = tempRoot()
    touch(root, 'keep.json')
    for (let index = 0; index < 5; index += 1) touch(outside, `secret${index}.json`, '{"role":"user"}')
    const linked = join(root, 'linked-dir')
    try {
      // junction 在 Windows 上不需要管理员权限；其它平台它等同于普通目录符号链接
      symlinkSync(outside, linked, 'junction')
    } catch {
      ctx.skip()
      return
    }

    const result = collectFiles([root], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)

    expect(result.value.files.map((file) => file.split(/[\\/]/).pop())).toEqual(['keep.json'])
    // 整个目录记一条，而不是里面每个文件各记一条（一条指向 `/` 的链接会记出几十万条）
    const outsideEntries = result.value.skipped.filter((entry) => entry.reason === 'outside-root')
    expect(outsideEntries).toEqual([{ path: linked, reason: 'outside-root' }])
  })

  it('still follows a symlinked directory that stays inside the root', (ctx) => {
    const root = tempRoot()
    touch(root, 'real/inner.json')
    try {
      symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction')
    } catch {
      ctx.skip()
      return
    }

    const result = collectFiles([root], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)

    // 链到根内的目录没越界；按 realpath 去重后同一个文件只出现一次
    expect(result.value.files).toHaveLength(1)
    expect(result.value.skipped).toEqual([])
  })

  it('does not treat every file as outside when the root itself is a filesystem root', () => {
    // 根目录的 realpath 本身以分隔符结尾（`C:\` 或 `/`），再拼一个分隔符就永远匹配不上。
    const fsRoot = parse(tmpdir()).root
    expect(isInside(fsRoot, join(fsRoot, 'anything.json'))).toBe(true)
    expect(isInside(fsRoot, join(fsRoot, 'a', 'b', 'c.json'))).toBe(true)

    // 用 join 拼路径，Windows 和 POSIX 都成立
    const base = join(fsRoot, 'a', 'b')
    expect(isInside(base, join(base, 'c.json'))).toBe(true)
    expect(isInside(base, base)).toBe(true)
    // 兄弟目录不能因为前缀相同就算在里面
    expect(isInside(base, join(fsRoot, 'a', 'bc', 'c.json'))).toBe(false)
    expect(isInside(base, join(fsRoot, 'a', 'c.json'))).toBe(false)
    // 名字以两个点开头的文件不是「往上走」
    expect(isInside(base, join(base, '..hidden.json'))).toBe(true)
  })

  it('still accepts a file the user named explicitly', () => {
    const root = tempRoot()
    const path = touch(root, 'explicit.json', '[]')
    const result = collectFiles([path], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)
    // 显式指定即意图：即使它是符号链接，也不按越界处理。
    expect(result.value.files).toEqual([path])
  })

  it('explains why an explicit non-trace file produced nothing', () => {
    const root = tempRoot()
    const path = touch(root, 'notes.md', '# hi')
    const result = collectFiles([path], { maxFiles: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('no-files')
    expect(result.error.detail).toEqual([path])
  })

  it('fails loudly on a missing path', () => {
    const root = tempRoot()
    const result = collectFiles([join(root, 'nope.json')], { maxFiles: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('path-missing')
    expect(result.error.detail[0]).toContain('nope.json')
  })

  it('fails instead of silently truncating past maxFiles', () => {
    const root = tempRoot()
    for (let index = 0; index < 4; index += 1) touch(root, `t${index}.json`)
    const result = collectFiles([root], { maxFiles: 3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-many-files')
    expect(result.error.detail).toEqual(['4', '3'])
  })

  it('deduplicates the same file reached twice', () => {
    const root = tempRoot()
    const path = touch(root, 'one.json')
    const result = collectFiles([root, path, path], { maxFiles: 10 })
    if (!result.ok) throw new Error(result.error.code)
    expect(result.value.files).toHaveLength(1)
  })

  it('reports no-files for an empty directory', () => {
    const root = tempRoot()
    const result = collectFiles([root], { maxFiles: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('no-files')
  })
})
