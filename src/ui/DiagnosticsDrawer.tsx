import { useEffect, useRef } from 'react'
import type { SessionAnalysis } from '../core/analysis'
import { formatTokens } from '../core/estimate'
import type { TelemetryEvent } from '../app/telemetry'
import { cx } from '../lib/format'
import { Icon } from './Icons'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  events: TelemetryEvent[]
  sessions: SessionAnalysis[]
  onClose: () => void
  onExport: () => void
  onClear: () => void
}

function clockOf(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function describe(event: TelemetryEvent): string {
  if (!event.data) return ''
  return Object.entries(event.data)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('  ')
}

function durationText(value: number): string {
  if (value < 1) return '<1ms'
  return `${Math.round(value)}ms`
}

export function DiagnosticsDrawer({ open, events, sessions, onClose, onExport, onClear }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const errors = events.filter((event) => event.level === 'error').length
  const warns = events.filter((event) => event.level === 'warn').length
  const slowest = [...events]
    .filter((event) => typeof event.durationMs === 'number')
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0]

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <div
        className="drawer glass"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="诊断日志"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h3>诊断</h3>
            <p>阶段耗时、规则异常与失败原因都记在这条环形日志里；导出后可直接附在问题报告里。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="diag-summary">
          <span>
            <b>{events.length}</b> 事件
          </span>
          <span className="bad"> {errors} 错误</span>
          <span className="warn"> {warns} 警告</span>
          {slowest && (
            <span>
              最慢 <b>{slowest.name}</b> {durationText(slowest.durationMs ?? 0)}
            </span>
          )}
        </div>

        <div className="drawer-body">
          <table className="diag-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>耗时</th>
                <th>数据</th>
              </tr>
            </thead>
            <tbody>
              {[...events].reverse().map((event) => (
                <tr
                  key={event.seq}
                  className={cx(event.level === 'error' && 'row-error', event.level === 'warn' && 'row-warn')}
                >
                  <td className="mono">{clockOf(event.at)}</td>
                  <td className="mono">{event.name}</td>
                  <td className="mono">
                    {event.durationMs !== undefined ? durationText(event.durationMs) : ''}
                  </td>
                  <td className="diag-data">{describe(event)}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={4} className="diag-empty">
                    暂无事件
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {sessions.length > 0 && (
            <details className="drawer-help" open>
              <summary>会话耗时</summary>
              <ul>
                {sessions.map((session) => (
                  <li key={session.id}>
                    <b>{session.trajectory.label}</b>
                    <span>
                      {session.trajectory.steps.length} 步 ·{' '}
                      {formatTokens(session.trajectory.meta.totalTokens)} tk · 解析{' '}
                      {durationText(session.diagnostics.parseMs)} · 规则{' '}
                      {durationText(session.diagnostics.rulesMs)}
                      {session.ruleIssues.length > 0 ? ` · 规则异常 ${session.ruleIssues.length}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <footer className="drawer-foot">
          <button type="button" className="btn ghost sm" onClick={onClear}>
            清空日志
          </button>
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={onExport}>
            导出诊断 JSON
          </button>
        </footer>
      </div>
    </div>
  )
}
