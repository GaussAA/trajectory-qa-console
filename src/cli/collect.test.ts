import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectFiles } from './collect'

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
