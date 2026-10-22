import type { Role, Severity } from '../core/types'

export const ROLE_LABEL: Record<Role, string> = {
  system: '系统',
  developer: '开发',
  user: '用户',
  assistant: '助手',
  tool: '工具',
  unknown: '未知',
}

export const ROLE_COLOR: Record<Role, string> = {
  system: '#94a3b8',
  developer: '#94a3b8',
  user: '#7dd3fc',
  assistant: '#a78bfa',
  tool: '#34d399',
  unknown: '#64748b',
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#fb7185',
  warn: '#fbbf24',
  info: '#60a5fa',
}

export const GRADE_COLOR: Record<string, string> = {
  A: '#34d399',
  B: '#5eead4',
  C: '#fbbf24',
  D: '#fb923c',
  E: '#fb7185',
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

export function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function nowStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}

export function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
