/** File ingestion with explicit limits.
 *
 *  Reading a file is the one place where an arbitrary input size can freeze the
 *  page, so the limit lives here, before `text()` is ever called. Rejections are
 *  returned as issues — the caller decides how to show them.
 */

import { SAMPLE_FILES } from '../core/sample'
import type { MessageKey } from '../i18n/core'

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
  /** Locale-neutral fallback. The UI renders `error.<code>` (or a dedicated
   *  key) with `params` instead; this string only shows up where no dictionary
   *  lookup is possible. */
  message: string
  code: IngestIssueCode
  /** Values for the message template — kept next to the issue so the UI never
   *  has to re-derive them from a formatted string. */
  params?: Record<string, string | number>
}

/** Which dictionary entry renders this issue.
 *
 *  The UI shows `t(issueMessageKey(code), issue.params)`; `issue.message` is
 *  only the fallback for code paths with no dictionary (logs, tests). Keeping
 *  the mapping next to the codes is what stops the two from drifting. */
export function issueMessageKey(code: IngestIssueCode): MessageKey {
  switch (code) {
    case 'too-many':
      return 'ingest.tooManyFiles'
    case 'too-large':
      return 'ingest.fileTooLarge'
    case 'total-limit':
      return 'ingest.totalTooLarge'
    case 'empty':
      return 'ingest.emptyFile'
    case 'read-failed':
      return 'ingest.readFailed'
    case 'analysis-failed':
      return 'error.analysis-failed'
    default:
      return 'error.analysis-failed'
  }
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
      file: `${files.length} files`,
      message: `At most ${limits.maxFiles} files at once; ignored ${files.length - limits.maxFiles}`,
      code: 'too-many',
      params: { limit: limits.maxFiles, extra: files.length - limits.maxFiles },
    })
  }

  let total = 0
  for (const file of files.slice(0, limits.maxFiles)) {
    if (file.size > limits.maxFileBytes) {
      issues.push({
        file: file.name,
        message: `${formatBytes(file.size)} over the ${formatBytes(limits.maxFileBytes)} per-file limit`,
        code: 'too-large',
        params: { size: formatBytes(file.size), limit: formatBytes(limits.maxFileBytes) },
      })
      continue
    }
    if (total + file.size > limits.maxTotalBytes) {
      issues.push({
        file: file.name,
        message: `Total import size over ${formatBytes(limits.maxTotalBytes)}`,
        code: 'total-limit',
        params: { limit: formatBytes(limits.maxTotalBytes), file: file.name },
      })
      continue
    }

    try {
      const text = await file.text()
      if (!text.trim()) {
        issues.push({ file: file.name, message: 'File is empty', code: 'empty', params: {} })
        continue
      }
      total += file.size
      inputs.push({ name: file.name, text })
    } catch (error) {
      issues.push({
        file: file.name,
        message: error instanceof Error ? error.message : String(error),
        code: 'read-failed',
        params: { reason: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  return { inputs, issues }
}

export function sampleInputs(): TextInput[] {
  return SAMPLE_FILES.map((sample) => ({ name: sample.name, text: sample.content }))
}
