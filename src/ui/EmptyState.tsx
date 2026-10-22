import { hasMessage, useI18n } from '../i18n'
import { Icon } from './Icons'

interface Props {
  onPick: () => void
  onSample: () => void
  issues: { file: string; message: string; code: string }[]
}

const SNIPPET = `[
  { "role": "user", "content": "check the reimbursement policy" },
  { "role": "assistant", "tool_calls": [
      { "id": "c1", "type": "function",
        "function": { "name": "search", "arguments": "{\\"q\\":\\"policy\\"}" } } ] },
  { "role": "tool", "tool_call_id": "c1", "content": "limit: 500 CNY" },
  { "role": "assistant", "content": "The limit is 500 CNY." }
]`

export function EmptyState({ onPick, onSample, issues }: Props) {
  const { locale, t } = useI18n()

  const issueText = (issue: { message: string; code: string }) => {
    const key = `error.${issue.code}`
    return hasMessage(locale, key) ? t(key) : issue.message
  }

  return (
    <main className="empty-wrap" aria-label={t('empty.title')}>
      <div className="empty-card glass">
        <div className="empty-icon">
          <Icon name="spark" size={26} />
        </div>
        <h2>{t('empty.title')}</h2>
        <p>{t('empty.description')}</p>

        <div className="empty-formats">
          <span className="format-chip">OpenAI messages</span>
          <span className="format-chip">tool_calls / tool_use</span>
          <span className="format-chip">JSONL</span>
          <span className="format-chip">auto pairing</span>
        </div>

        <div className="empty-actions">
          <button type="button" className="btn primary" onClick={onPick}>
            <Icon name="upload" size={14} />
            {t('action.pickFile')}
          </button>
          <button type="button" className="btn ghost" onClick={() => onSample()}>
            {t('action.loadSamples')}
          </button>
        </div>

        <p className="empty-drop-hint">{t('drop.hint')}</p>

        <pre className="empty-snippet">{SNIPPET}</pre>

        {issues.length > 0 && (
          <div className="empty-issues">
            {issues.map((issue) => (
              <div key={`${issue.file}-${issue.message}`}>
                <b>{issue.file}</b>：{issueText(issue)}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
