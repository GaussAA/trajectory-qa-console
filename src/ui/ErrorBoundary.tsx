import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'

interface Props {
  nameKey: MessageKey
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  compact?: boolean
}

interface State {
  error: Error | null
}

function BoundaryFallback({
  nameKey,
  message,
  onRetry,
  compact,
}: {
  nameKey: MessageKey
  message: string
  onRetry: () => void
  compact?: boolean
}) {
  const t = useT()
  return (
    <div className={compact ? 'panel-fallback compact' : 'panel-fallback'} role="alert">
      <div className="fallback-title">{t('boundary.unavailable', { name: t(nameKey) })}</div>
      <div className="fallback-message">{message || t('common.unknownError')}</div>
      <div className="fallback-actions">
        <button type="button" className="btn ghost sm" onClick={onRetry}>
          {t('boundary.retry')}
        </button>
      </div>
      <p className="fallback-hint">{t('boundary.hint')}</p>
    </div>
  )
}

/** Contains a render failure to one panel instead of the whole document. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <BoundaryFallback
        nameKey={this.props.nameKey}
        message={error.message}
        onRetry={this.reset}
        compact={this.props.compact}
      />
    )
  }
}
