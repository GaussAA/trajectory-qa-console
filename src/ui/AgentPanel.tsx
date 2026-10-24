/** 诊断面板：点一下，看模型怎么解释这批分数。
 *
 *  状态全部留在组件内部，不进 reducer——与「选择态」同样的理由：它不影响评分、
 *  不持久化、关掉即忘。诊断结论也**不进**任何评分卡（不变量 7）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionAnalysis } from '../core/analysis'
import type { RulePack } from '../core/model'
import type { AgentEvent, AgentRun } from '../core/agent/types'
import { diagnose, type AgentTarget } from '../app/agent-client'
import { useI18n, type MessageKey } from '../i18n'
import { cx, downloadFile } from '../lib/format'
import { Icon } from './Icons'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  /** null 表示地址栏里没给 `?agent=`：诊断不可用，只显示怎么开。 */
  target: AgentTarget | null
  sessions: SessionAnalysis[]
  pack: RulePack
  onClose: () => void
  /** 提供时，界面会把一次请求记为一条遥测事件（失败、耗时、轮次）。 */
  onFinish?: (info: { ok: boolean; code?: string; rounds: number; toolCalls: number; ms: number }) => void
}

type Phase = 'idle' | 'running' | 'done' | 'error'

interface Failure {
  code: string
  message: string
}

export function AgentPanel({ open, target, sessions, pack, onClose, onFinish }: Props) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<AgentEvent[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [partial, setPartial] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 关面板或卸载时掐掉在途请求：让它在后台烧完配额没有意义。
  useEffect(() => {
    if (open) return
    abortRef.current?.abort()
    abortRef.current = null
  }, [open])

  useEffect(() => () => abortRef.current?.abort(), [])

  const start = useCallback(async () => {
    if (!target || phase === 'running') return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('running')
    setProgress([])
    setRun(null)
    setPartial(null)
    setFailure(null)

    const startedAt = Date.now()
    const result = await diagnose({
      target,
      sessions,
      pack,
      signal: controller.signal,
      onEvent: (event) => setProgress((prev) => [...prev.slice(-40), event]),
    })

    if (controller.signal.aborted) {
      setPhase('idle')
      return
    }
    abortRef.current = null

    if (!result.ok) {
      setFailure({ code: result.code, message: result.message })
      setPhase('error')
      onFinish?.({ ok: false, code: result.code, rounds: 0, toolCalls: 0, ms: Date.now() - startedAt })
      return
    }

    setRun(result.run)
    setPartial(result.partial ?? null)
    setPhase('done')
    onFinish?.({
      ok: result.run.ok,
      code: result.run.error?.code,
      rounds: result.run.trace.rounds,
      toolCalls: result.run.trace.toolCalls,
      ms: Date.now() - startedAt,
    })
  }, [target, phase, sessions, pack, onFinish])

  if (!open) return null

  const rounds = progress.filter((event) => event.kind === 'round').length
  const tools = progress.filter((event) => event.kind === 'tool')
  const lastTool = tools.at(-1)

  const downloadProposal = (index: number) => {
    const proposal = run?.proposals[index]
    if (!proposal) return
    downloadFile(
      'proposal.pack.json',
      `${JSON.stringify(proposal.pack, null, 2)}\n`,
      'application/json',
    )
  }

  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <div
        className="drawer agent-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('agent.ui.title')}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h3>{t('agent.ui.title')}</h3>
            <p>{t('agent.ui.intro')}</p>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="drawer-body agent-body">
          {!target ? (
            <div className="agent-hint">
              <b>{t('agent.ui.offlineTitle')}</b>
              <p>{t('agent.ui.offlineHint')}</p>
              <code>trajectory-qa serve</code>
              <p className="agent-mute">{t('agent.ui.offlineUrl')}</p>
            </div>
          ) : null}

          {target && phase === 'idle' && (
            <div className="agent-hint">
              <p>{t('agent.ui.scope', { count: sessions.length, model: target.endpoint })}</p>
              <p className="agent-mute">{t('agent.ui.cost')}</p>
            </div>
          )}

          {phase === 'running' && (
            <div className="agent-progress" role="status" aria-live="polite">
              <div className="agent-progress-head">
                <span className="spinner" />
                <b>{t('agent.ui.running', { round: Math.max(1, rounds) })}</b>
              </div>
              <ul>
                {tools.slice(-8).map((event, index) =>
                  event.kind === 'tool' ? (
                    <li key={`${event.round}-${event.name}-${index}`}>
                      <span className={cx('agent-tool', !event.ok && 'failed')}>{event.name}</span>
                      <span className="agent-mute">{event.ms}ms</span>
                    </li>
                  ) : null,
                )}
              </ul>
              {lastTool && lastTool.kind === 'tool' && (
                <p className="agent-mute">{t('agent.ui.lastTool', { name: lastTool.name })}</p>
              )}
            </div>
          )}

          {phase === 'error' && failure && (
            <div className="agent-hint agent-failure">
              <b>
                {failure.code === 'offline'
                  ? t('agent.ui.offlineTitle')
                  : failure.code === 'aborted'
                    ? t('agent.ui.aborted')
                    : t('agent.ui.failed')}
              </b>
              {failure.code === 'offline' ? (
                <>
                  <p>{t('agent.ui.offlineHint')}</p>
                  <code>trajectory-qa serve</code>
                </>
              ) : (
                <p className="agent-mute">{failure.message}</p>
              )}
            </div>
          )}

          {phase === 'done' && run && (
            <div className="agent-result">
              {partial && <p className="agent-partial">{partial}</p>}
              {run.trace.truncated && (
                <p className="agent-partial">
                  {t('agent.ui.notConverged', {
                    reason: t(`agent.stop.${run.trace.stopReason}` as MessageKey),
                  })}
                </p>
              )}

              <section>
                <h4>{t('agent.ui.conclusion')}</h4>
                <p className="agent-mute agent-note">{t('agent.ui.conclusionNote')}</p>
                <p className="agent-verdict">
                  {run.diagnosis?.verdict ?? run.answer ?? t('agent.ui.noConclusion')}
                </p>
              </section>

              {(run.diagnosis?.rootCauses.length ?? 0) > 0 && (
                <section>
                  <h4>{t('agent.ui.rootCauses')}</h4>
                  <ul className="agent-list">
                    {run.diagnosis?.rootCauses.map((item, index) => (
                      <li key={index}>
                        <span>{item.cause}</span>
                        {item.evidence !== '' && <em>{item.evidence}</em>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(run.diagnosis?.actions.length ?? 0) > 0 && (
                <section>
                  <h4>{t('agent.ui.actions')}</h4>
                  <ul className="agent-list">
                    {run.diagnosis?.actions.map((item, index) => (
                      <li key={index}>
                        <span>{item.action}</span>
                        {item.rationale !== '' && <em>{item.rationale}</em>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {run.proposals.length > 0 && (
                <section>
                  <h4>{t('agent.ui.proposals')}</h4>
                  <p className="agent-mute agent-note">{t('agent.ui.proposalNote')}</p>
                  {run.proposals.map((proposal, index) => (
                    <div className="agent-proposal" key={proposal.id}>
                      <div>
                        <b>{proposal.id}</b> {proposal.rationale}
                      </div>
                      <div className="agent-mute">
                        {t('agent.ui.proposalDelta', {
                          before: proposal.averageBefore,
                          after: proposal.averageAfter,
                          delta: proposal.delta > 0 ? `+${proposal.delta}` : String(proposal.delta),
                        })}
                      </div>
                      <button type="button" className="btn ghost sm" onClick={() => downloadProposal(index)}>
                        <Icon name="download" size={12} />
                        {t('agent.ui.downloadProposal')}
                      </button>
                    </div>
                  ))}
                </section>
              )}

              <p className="agent-mute">
                {t('agent.ui.stats', {
                  rounds: run.trace.rounds,
                  tools: run.trace.toolCalls,
                  tokens: run.usage.prompt + run.usage.completion,
                })}
              </p>
            </div>
          )}
        </div>

        <footer className="drawer-foot">
          {phase === 'running' ? (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                abortRef.current?.abort()
                abortRef.current = null
                setPhase('idle')
              }}
            >
              {t('common.cancel')}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              onClick={() => void start()}
              disabled={!target || sessions.length === 0}
            >
              <Icon name="spark" size={13} />
              {phase === 'done' || phase === 'error' ? t('agent.ui.again') : t('agent.ui.start')}
            </button>
          )}
          <span className="agent-spacer" />
          <button type="button" className="btn ghost sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>
  )
}
