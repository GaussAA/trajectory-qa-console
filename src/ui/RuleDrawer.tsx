import { useEffect, useRef, useState } from 'react'
import type { RuleIssue, RulePack } from '../core/rules'
import { validatePack } from '../core/rules'
import { downloadFile, nowStamp } from '../lib/format'
import { Icon } from './Icons'

interface Props {
  open: boolean
  pack: RulePack
  ruleIssues: RuleIssue[]
  onClose: () => void
  onApply: (pack: RulePack) => void
}

const FIELD_HELP = [
  ['scope = step', 'index（从 0）、step（从 1）、role、prevRole、textLen、toolCallCount、unpairedCalls、invalidArgs、toolErrorCount、resultChars、durationMs、durationSeconds、tokens、claimWithoutEvidence、hasImage'],
  ['scope = trajectory', 'stepCount、userTurns、assistantTurns、toolCalls、toolErrors、unpairedCalls、orphanResults、invalidArgs、errorRate、errorRatePercent、totalTokens、duplicateCalls、maxRepeatRun、hasSystem、hasFinalAnswer、privacyHits、claimWithoutEvidence'],
  ['可用函数', 'len · includes · any · all · count · sum · round · floor · ceil · abs · min · max · lower · upper · startsWith · endsWith'],
  ['消息模板', '用 {字段名} 插入上下文值，例如「第 {step} 步有 {unpairedCalls} 个未配对调用」'],
]

export function RuleDrawer({ open, pack, ruleIssues, onClose, onApply }: Props) {
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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
      setErrors(result.errors)
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

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <div className="drawer glass" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h3>规则包</h3>
            <p>维度与规则都是数据：改这里即可扩展质检口径，表达式在沙箱内求值，不会执行任意代码。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）">
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
            <summary>字段与语法参考</summary>
            <ul>
              {FIELD_HELP.map(([title, body]) => (
                <li key={title}>
                  <b>{title}</b>
                  <span>{body}</span>
                </li>
              ))}
            </ul>
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
