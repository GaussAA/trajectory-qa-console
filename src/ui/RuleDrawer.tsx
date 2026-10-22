import { useEffect, useRef, useState } from 'react'
import type { ScoreCard } from '../core/analysis'
import { EXPR_FUNCTIONS } from '../core/expr'
import type { RuleIssue, RulePack } from '../core/model'
import { fieldsForScope, formatPackErrors, validatePack } from '../core/rules/contract'
import { SEVERITY_LABEL } from '../core/model'
import { downloadFile, nowStamp } from '../lib/format'
import { Icon } from './Icons'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  pack: RulePack
  card: ScoreCard | null
  ruleIssues: RuleIssue[]
  onClose: () => void
  onApply: (pack: RulePack) => void
}

export function RuleDrawer({ open, pack, card, ruleIssues, onClose, onApply }: Props) {
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (!open) return
    setDraft(JSON.stringify(pack, null, 2))
    setErrors([])
    setStatus('')
  }, [open, pack])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const apply = () => {
    setStatus('')
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (error) {
      setErrors([`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`])
      return
    }
    const result = validatePack(parsed)
    if (!result.ok) {
      setErrors(formatPackErrors(result.errors).slice(0, 12))
      return
    }
    setErrors([])
    onApply(result.pack)
    setStatus(`已应用：${result.pack.rules.length} 条规则 / ${result.pack.dimensions.length} 个维度`)
  }

  const reset = () => {
    setDraft(JSON.stringify(pack, null, 2))
    setErrors([])
    setStatus('')
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setDraft(text)
    setErrors([])
    setStatus(`已载入 ${file.name}，尚未应用`)
  }

  const uniqueIssues = new Map<string, string>()
  for (const issue of ruleIssues) uniqueIssues.set(`${issue.ruleId}:${issue.message}`, issue.message)

  const hits = new Map<string, number>()
  for (const finding of card?.findings ?? []) {
    if (finding.ruleId === 'manual') continue
    hits.set(finding.ruleId, (hits.get(finding.ruleId) ?? 0) + 1)
  }

  const stepFields = fieldsForScope('step')
  const trajectoryFields = fieldsForScope('trajectory')

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <div
        className="drawer glass"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="规则包编辑"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h3>规则包</h3>
            <p>
              维度与规则都是数据。保存前会做结构校验与表达式编译，字段拼错会给出建议；
              表达式在沙箱内求值，不会执行任意代码。
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="drawer-body">
          <textarea
            className="pack-editor"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          {errors.length > 0 && (
            <div className="drawer-errors">
              {errors.map((error, index) => (
                <div key={index}>{error}</div>
              ))}
            </div>
          )}
          {status && <div className="drawer-status">{status}</div>}

          {uniqueIssues.size > 0 && (
            <div className="drawer-issues">
              <span>当前会话中的规则异常</span>
              <ul>
                {[...uniqueIssues.entries()].map(([key, message]) => (
                  <li key={key}>
                    <b>{key.split(':')[0]}</b> {message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="drawer-help">
            <summary>规则命中情况（当前会话）</summary>
            <div className="hit-list">
              {pack.rules.map((rule) => {
                const count = hits.get(rule.id) ?? 0
                return (
                  <div key={rule.id} className={count > 0 ? 'hit-row hit' : 'hit-row'}>
                    <span className="mono">{rule.id}</span>
                    <span className="hit-meta">
                      {SEVERITY_LABEL[rule.severity]} · 权重 {rule.scoreImpact}
                    </span>
                    <span className="hit-count">{count}</span>
                  </div>
                )
              })}
            </div>
          </details>

          <details className="drawer-help">
            <summary>字段与语法参考</summary>
            <div className="field-groups">
              <div>
                <h5>step 作用域（{stepFields.length} 个字段）</h5>
                <ul>
                  {stepFields.map((field) => (
                    <li key={field.name}>
                      <b>{field.name}</b>
                      <span>
                        {field.type} · {field.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h5>trajectory 作用域（{trajectoryFields.length} 个字段）</h5>
                <ul>
                  {trajectoryFields.map((field) => (
                    <li key={field.name}>
                      <b>{field.name}</b>
                      <span>
                        {field.type} · {field.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h5>可用函数</h5>
                <ul>
                  {EXPR_FUNCTIONS.map((fn) => (
                    <li key={fn.name}>
                      <b>{fn.signature}</b>
                      <span>{fn.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="hint">
              消息模板用 {'{字段名}'} 插入上下文值，例如「第 {'{step}'} 步有 {'{unpairedCalls}'}{' '}
              个未配对调用」。
            </p>
          </details>
        </div>

        <footer className="drawer-foot">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.jsonl"
            hidden
            onChange={(event) => {
              void importFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
            导入
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => downloadFile(`rule-pack-${nowStamp()}.json`, draft, 'application/json')}
          >
            导出
          </button>
          <button type="button" className="btn ghost sm" onClick={reset}>
            还原
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary sm" onClick={apply}>
            校验并应用
          </button>
        </footer>
      </div>
    </div>
  )
}
