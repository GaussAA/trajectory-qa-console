import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'

interface Props {
  nameKey: MessageKey
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  compact?: boolean
  /** 这个值一变，失败页就自动清掉重试。传「这个面板依赖什么」：时间线传会话，检视器传会话+步骤。
   *  没有它，用户切到另一个会话或另一步后，失败页还留在原地，只能手点「重试」；
   *  而对确定性的渲染错误，手点重试只会再抛一次。 */
  resetKey?: string | number
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

  componentDidUpdate(prev: Props): void {
    // 只在 key 真的变了才清：失败页自己触发的那次更新 key 没变，不会陷入「清掉→再抛→再清」。
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset()
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
