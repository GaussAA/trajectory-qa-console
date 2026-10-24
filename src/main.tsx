import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, isLocale, type Locale } from './i18n'
import App from './ui/App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

/** `?lang=en` is a demo/debug override; the stored choice still wins elsewhere. */
function localeFromUrl(): Locale | undefined {
  const value = new URLSearchParams(window.location.search).get('lang')
  return isLocale(value) ? value : undefined
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider initialLocale={localeFromUrl()}>
      {/* App 自己的渲染（评分、取步）在各面板的边界之外：那里一旦抛错，没有这一层就是整页白屏。
          放在 Provider 里面，失败页才能用字典出文案。 */}
      <ErrorBoundary nameKey="panel.app">
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
)
