// @vitest-environment jsdom
/** Import behaviour lives in the controller, not in App — so it is tested here.
 *
 *  The drag-and-drop entry point cannot be driven from jsdom (React's drop
 *  event never fires there), which is exactly why the bug these tests cover
 *  went unnoticed for so long: nothing was exercising this path at all. */

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { INGEST_LIMITS, type IngestFile } from '../app/ingest'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import { I18nProvider } from '../i18n'
import { useWorkspaceController } from './useWorkspaceController'

function setup() {
  const telemetry = createTelemetry()
  const view = renderHook(
    () =>
      useWorkspaceController({
        analyzer: createSyncAnalyzer(),
        persistence: createPersistence(createMemoryStorage()),
        telemetry,
      }),
    { wrapper: ({ children }) => <I18nProvider initialLocale="zh-CN">{children}</I18nProvider> },
  )
  return { ...view, telemetry }
}

/** A real, analysable trace — an empty JSON array parses but yields nothing. */
const TRACE = JSON.stringify([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'ok' },
])
const ok: IngestFile = { name: 'ok.json', size: TRACE.length, text: async () => TRACE }

function tooLarge(): IngestFile {
  return { name: 'huge.json', size: INGEST_LIMITS.maxFileBytes + 1, text: async () => '[]' }
}

describe('import reports every problem it had', () => {
  it('keeps a rejected file visible when the other files loaded fine', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([...Array.from({ length: 3 }, () => ok), tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.sessions.length).toBeGreaterThan(0))

    // The good sessions still load — and the bad file is *reported*, not
    // silently dropped. It used to vanish whenever at least one file loaded.
    expect(result.current.state.sessions.length).toBeGreaterThan(0)
    expect(result.current.state.issues.map((issue) => issue.code)).toEqual(['too-large'])
    expect(result.current.state.issues[0]?.file).toBe('huge.json')
  })

  it('carries the numbers the message needs', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([ok, tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.issues.length).toBeGreaterThan(0))

    const issue = result.current.state.issues[0]
    expect(issue?.params?.size).toBeTruthy()
    expect(issue?.params?.limit).toBeTruthy()
    // The dictionary entry needs both; a fallback string is not good enough.
    expect(issue?.code).toBe('too-large')
  })

  it('reports the file count limit alongside the files that did load', async () => {
    const { result } = setup()
    const files = [
      ...Array.from({ length: INGEST_LIMITS.maxFiles }, () => ok),
      { name: 'extra.json', size: 2, text: async () => '[]' } satisfies IngestFile,
    ]

    await act(async () => {
      void result.current.actions.ingestFiles(files)
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.issues.length).toBeGreaterThan(0))

    expect(result.current.state.issues.map((issue) => issue.code)).toEqual(['too-many'])
    expect(result.current.state.issues[0]?.params).toMatchObject({ limit: INGEST_LIMITS.maxFiles, extra: 1 })
  })

  it('still fails loudly when nothing at all could be read', async () => {
    const { result } = setup()

    await act(async () => {
      void result.current.actions.ingestFiles([tooLarge()])
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.lastError).toBeTruthy())

    // Failure is recorded on lastError; the phase stays put so whatever was
    // already loaded remains on screen.
    expect(result.current.state.lastError?.code).toBe('analysis-failed')
    expect(result.current.state.sessions).toHaveLength(0)
  })
})
