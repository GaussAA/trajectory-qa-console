import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, isLocale, type Locale } from './i18n'
import App from './ui/App'
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
      <App />
    </I18nProvider>
  </StrictMode>,
)
