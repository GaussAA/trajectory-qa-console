import { describe, expect, it } from 'vitest'
import { INGEST_LIMITS, readFiles, sampleInputs, type IngestFile } from './ingest'

function fakeFile(name: string, content: string, size = content.length): IngestFile {
  return { name, size, text: async () => content }
}

describe('ingest', () => {
  it('reads accepted files in order', async () => {
    const result = await readFiles([fakeFile('a.json', '[]'), fakeFile('b.jsonl', '{}')])
    expect(result.inputs.map((input) => input.name)).toEqual(['a.json', 'b.jsonl'])
    expect(result.issues).toEqual([])
  })

  it('rejects files over the per-file limit before reading them', async () => {
    let read = false
    const huge: IngestFile = {
      name: 'huge.json',
      size: INGEST_LIMITS.maxFileBytes + 1,
      text: async () => {
        read = true
        return '[]'
      },
    }
    const result = await readFiles([huge])
    expect(result.inputs).toHaveLength(0)
    expect(result.issues[0]?.code).toBe('too-large')
    expect(read).toBe(false)
  })

  it('caps the number of files per drop', async () => {
    const files = Array.from({ length: INGEST_LIMITS.maxFiles + 2 }, (_, i) => fakeFile(`f${i}.json`, '[]', 2))
    const result = await readFiles(files)
    expect(result.inputs).toHaveLength(INGEST_LIMITS.maxFiles)
    expect(result.issues.some((issue) => issue.code === 'too-many')).toBe(true)
  })

  it('enforces the total byte budget', async () => {
    const result = await readFiles(
      [fakeFile('a.json', 'x'.repeat(10), 10), fakeFile('b.json', 'x'.repeat(10), 10)],
      { maxFiles: 5, maxFileBytes: 100, maxTotalBytes: 15 },
    )
    expect(result.inputs).toHaveLength(1)
    expect(result.issues[0]?.code).toBe('total-limit')
  })

  it('reports empty files and read failures without aborting the batch', async () => {
    const broken: IngestFile = {
      name: 'broken.json',
      size: 10,
      text: async () => {
        throw new Error('EACCES')
      },
    }
    const result = await readFiles([fakeFile('empty.json', '   '), broken, fakeFile('ok.json', '[]')])
    expect(result.inputs.map((input) => input.name)).toEqual(['ok.json'])
    expect(result.issues.map((issue) => issue.code)).toEqual(['empty', 'read-failed'])
  })

  it('ships four demo inputs', () => {
    expect(sampleInputs()).toHaveLength(4)
    expect(sampleInputs().every((input) => input.text.length > 0)).toBe(true)
  })
})
