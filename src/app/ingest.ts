/** File ingestion with explicit limits.
 *
 *  Reading a file is the one place where an arbitrary input size can freeze the
 *  page, so the limit lives here, before `text()` is ever called. Rejections are
 *  returned as issues — the caller decides how to show them.
 */

import { SAMPLE_FILES } from '../core/sample'

export interface IngestFile {
  name: string
  size: number
  text(): Promise<string>
}

export interface TextInput {
  name: string
  text: string
}

export type IngestIssueCode =
  'too-large' | 'too-many' | 'total-limit' | 'read-failed' | 'empty' | 'analysis-failed'

export interface IngestIssue {
  file: string
  message: string
  code: IngestIssueCode
}

export interface IngestLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export const INGEST_LIMITS: IngestLimits = {
  maxFiles: 20,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface ReadResult {
  inputs: TextInput[]
  issues: IngestIssue[]
}

export async function readFiles(
  files: IngestFile[],
  limits: IngestLimits = INGEST_LIMITS,
): Promise<ReadResult> {
  const inputs: TextInput[] = []
  const issues: IngestIssue[] = []

  if (files.length > limits.maxFiles) {
    issues.push({
      file: `${files.length} 个文件`,
      message: `一次最多导入 ${limits.maxFiles} 个文件，已忽略多余的 ${files.length - limits.maxFiles} 个`,
      code: 'too-many',
    })
  }

  let total = 0
  for (const file of files.slice(0, limits.maxFiles)) {
    if (file.size > limits.maxFileBytes) {
      issues.push({
        file: file.name,
        message: `文件 ${formatBytes(file.size)} 超过单文件上限 ${formatBytes(limits.maxFileBytes)}`,
        code: 'too-large',
      })
      continue
    }
    if (total + file.size > limits.maxTotalBytes) {
      issues.push({
        file: file.name,
        message: `累计导入超过 ${formatBytes(limits.maxTotalBytes)}，已跳过`,
        code: 'total-limit',
      })
      continue
    }

    try {
      const text = await file.text()
      if (!text.trim()) {
        issues.push({ file: file.name, message: '文件内容为空', code: 'empty' })
        continue
      }
      total += file.size
      inputs.push({ name: file.name, text })
    } catch (error) {
      issues.push({
        file: file.name,
        message: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        code: 'read-failed',
      })
    }
  }

  return { inputs, issues }
}

export function sampleInputs(): TextInput[] {
  return SAMPLE_FILES.map((sample) => ({ name: sample.name, text: sample.content }))
}
