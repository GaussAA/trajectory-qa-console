import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  name: string
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  compact?: boolean
}

interface State {
  error: Error | null
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
      <div className={this.props.compact ? 'panel-fallback compact' : 'panel-fallback'} role="alert">
        <div className="fallback-title">{this.props.name}不可用</div>
        <div className="fallback-message">{error.message || '渲染时发生未知错误'}</div>
        <div className="fallback-actions">
          <button type="button" className="btn ghost sm" onClick={this.reset}>
            重试该面板
          </button>
        </div>
        <p className="fallback-hint">其余面板不受影响；诊断面板中可导出本次现场。</p>
      </div>
    )
  }
}
