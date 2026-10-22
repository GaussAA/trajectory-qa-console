import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { formatTokens } from './core/estimate'
import { parseTrajectory } from './core/parse'
import {
  annotationFindings,
  DEFAULT_PACK,
  runRules,
  validatePack,
  type Annotation,
  type RulePack,
} from './core/rules'
import { SAMPLE_FILES } from './core/sample'
import { scoreTrajectory, type ScoreCard } from './core/score'
import type { Severity, Trajectory } from './core/types'
import { downloadFile, nowStamp } from './lib/format'
import { buildJsonReport, buildMarkdownReport } from './lib/report'
import { EmptyState } from './ui/EmptyState'
import { FindingsPanel } from './ui/FindingsPanel'
import { Icon } from './ui/Icons'
import { Inspector } from './ui/Inspector'
import { RuleDrawer } from './ui/RuleDrawer'
import { ScorePanel } from './ui/ScorePanel'
import { SessionList } from './ui/SessionList'
import { Timeline } from './ui/Timeline'

const PACK_KEY = 'tqa.pack.v1'
const ANNOTATION_KEY = 'tqa.annotations.v1'

interface LoadIssue {
  file: string
  message: string
}

interface TextInput {
  name: string
  text: string
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function loadPack(): RulePack {
  try {
    const raw = localStorage.getItem(PACK_KEY)
    if (!raw) return DEFAULT_PACK
    const result = validatePack(JSON.parse(raw))
    return result.ok ? result.pack : DEFAULT_PACK
  } catch {
    return DEFAULT_PACK
  }
}

function loadAnnotations(): Annotation[] {
  try {
    const raw = localStorage.getItem(ANNOTATION_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Annotation =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.trajectoryId === 'string' &&
        typeof item.note === 'string',
    )
  } catch {
    return []
  }
}

export default function App() {
  const [trajectories, setTrajectories] = useState<Trajectory[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [pack, setPack] = useState<RulePack>(loadPack)
  const [annotations, setAnnotations] = useState<Annotation[]>(loadAnnotations)
  const [issues, setIssues] = useState<LoadIssue[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const demoLoaded = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem(PACK_KEY, JSON.stringify(pack))
    } catch {
      // storage disabled (private mode / file://); the session still works
    }
  }, [pack])

  useEffect(() => {
    try {
      localStorage.setItem(ANNOTATION_KEY, JSON.stringify(annotations))
    } catch {
      // ignore
    }
  }, [annotations])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (selectedStep === null) return
    const element = document.getElementById(`step-row-${selectedStep}`)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [selectedStep, selectedId])

  const cards = useMemo(() => {
    const map = new Map<string, ScoreCard>()
    for (const trajectory of trajectories) {
      const { findings, ruleIssues } = runRules(trajectory, pack)
      const merged = [...findings, ...annotationFindings(trajectory.id, annotations)]
      map.set(trajectory.id, scoreTrajectory(merged, pack.dimensions, ruleIssues))
    }
    return map
  }, [trajectories, pack, annotations])

  const selected = trajectories.find((trajectory) => trajectory.id === selectedId) ?? null
  const selectedCard = selected ? cards.get(selected.id) : undefined
  const selectedStepData =
    selected && selectedStep !== null ? (selected.steps[selectedStep] ?? null) : null

  const totals = useMemo(() => {
    const steps = trajectories.reduce((sum, trajectory) => sum + trajectory.steps.length, 0)
    const tokens = trajectories.reduce((sum, trajectory) => sum + trajectory.meta.totalTokens, 0)
    const scores = trajectories
      .map((trajectory) => cards.get(trajectory.id)?.overall)
      .filter((score): score is number => score !== undefined)
    const average =
      scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0
    return { steps, tokens, average }
  }, [trajectories, cards])

  const ingestTexts = useCallback(async (inputs: TextInput[]) => {
    const loaded: Trajectory[] = []
    const problems: LoadIssue[] = []
    const batch = uid().slice(0, 8)

    for (const input of inputs) {
      try {
        const parsed = parseTrajectory(input.text, input.name)
        parsed.forEach((trajectory, index) => {
          loaded.push({ ...trajectory, id: `${batch}-${index}-${trajectory.id}` })
        })
      } catch (error) {
        problems.push({
          file: input.name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    setIssues(problems)
    if (loaded.length === 0) {
      setToast(problems[0] ? `未能解析：${problems[0].message}` : '没有可用的轨迹')
      return
    }

    setTrajectories((previous) => [...previous, ...loaded])
    setSelectedId(loaded[0]?.id ?? null)
    setSelectedStep(null)
    setToast(
      problems.length > 0
        ? `已载入 ${loaded.length} 条，${problems.length} 个文件解析失败`
        : `已载入 ${loaded.length} 条轨迹`,
    )
  }, [])

  const ingestFiles = useCallback(
    async (files: File[]) => {
      const inputs: TextInput[] = []
      for (const file of files) {
        try {
          inputs.push({ name: file.name, text: await file.text() })
        } catch (error) {
          setIssues((previous) => [
            ...previous,
            { file: file.name, message: error instanceof Error ? error.message : String(error) },
          ])
        }
      }
      await ingestTexts(inputs)
    },
    [ingestTexts],
  )

  const loadSamples = useCallback(
    (index?: number) => {
      const picked =
        index === undefined ? SAMPLE_FILES : SAMPLE_FILES[index] ? [SAMPLE_FILES[index]] : SAMPLE_FILES
      void ingestTexts(picked.map((sample) => ({ name: sample.name, text: sample.content })))
    },
    [ingestTexts],
  )

  // Deep links for demos: #demo loads all samples, #demo:3 loads the third one.
  useEffect(() => {
    const match = /^#demo(?::(\d+))?$/.exec(window.location.hash)
    if (!match || demoLoaded.current) return
    demoLoaded.current = true
    const index = match[1] ? Number(match[1]) - 1 : undefined
    loadSamples(index)
  }, [loadSamples])

  // Land on the most useful step: the first offending one, else the first tool
  // call, else the first non-system message.
  useEffect(() => {
    if (!selectedId) return
    const trajectory = trajectories.find((item) => item.id === selectedId)
    const card = cards.get(selectedId)
    if (!trajectory || !card) return
    const offending = card.findings.find((finding) => finding.stepIndex !== undefined)
    if (offending?.stepIndex !== undefined) {
      setSelectedStep(offending.stepIndex)
      return
    }
    const withCall = trajectory.steps.find((step) => step.toolCalls.length > 0)
    if (withCall) {
      setSelectedStep(withCall.index)
      return
    }
    const nonSystem = trajectory.steps.find((step) => step.role !== 'system')
    setSelectedStep(nonSystem?.index ?? 0)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('drawer')) setDrawerOpen(true)
  }, [])

  const clearAll = () => {
    setTrajectories([])
    setSelectedId(null)
    setSelectedStep(null)
    setAnnotations([])
    setIssues([])
    setToast('已清空工作区')
  }

  const applyPack = (next: RulePack) => {
    setPack(next)
    setToast(`规则包已更新：${next.rules.length} 条规则`)
  }

  const addAnnotation = (
    stepIndex: number,
    dimension: string,
    severity: Severity,
    note: string,
  ) => {
    if (!selected) return
    setAnnotations((previous) => [
      ...previous,
      {
        id: uid(),
        trajectoryId: selected.id,
        stepIndex,
        dimension,
        severity,
        note,
      },
    ])
    setToast('已添加人工标注，计入语义维度')
  }

  const removeAnnotation = (id: string) => {
    setAnnotations((previous) => previous.filter((annotation) => annotation.id !== id))
  }

  const activeRuleIssues = selectedCard?.ruleIssues ?? []

  const exportMarkdown = () => {
    if (trajectories.length === 0) return
    const content = buildMarkdownReport({
      trajectories,
      cards,
      pack,
      generatedAt: new Date(),
    })
    downloadFile(`trajectory-qa-${nowStamp()}.md`, content, 'text/markdown')
  }

  const exportJson = () => {
    if (trajectories.length === 0) return
    const content = buildJsonReport({ trajectories, cards, pack, generatedAt: new Date() })
    downloadFile(`trajectory-qa-${nowStamp()}.json`, content, 'application/json')
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void ingestFiles(files)
  }

  const onDragEnter = (event: DragEvent) => {
    event.preventDefault()
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="spark" size={18} />
          </span>
          <div>
            <h1>轨迹质检台</h1>
            <span className="brand-sub">Trajectory QA Console</span>
          </div>
        </div>

        {trajectories.length > 0 && (
          <div className="kpis">
            <span className="kpi">
              <b>{trajectories.length}</b>
              <span>会话</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.steps}</b>
              <span>步骤</span>
            </span>
            <i className="kpi-sep kpi-optional" />
            <span className="kpi kpi-optional">
              <b>{formatTokens(totals.tokens)}</b>
              <span>tokens</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.average}</b>
              <span>平均分</span>
            </span>
          </div>
        )}

        <span className="topbar-spacer" />

        <div className="topbar-actions">
          <button type="button" className="btn ghost sm" onClick={() => loadSamples()}>
            示例轨迹
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDrawerOpen(true)}>
            <Icon name="sliders" size={13} />
            规则包
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={exportJson}
            disabled={trajectories.length === 0}
          >
            JSON
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={exportMarkdown}
            disabled={trajectories.length === 0}
          >
            <Icon name="download" size={13} />
            导出报告
          </button>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.jsonl,.txt,application/json"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) void ingestFiles(files)
        }}
      />

      {trajectories.length === 0 || !selected || !selectedCard ? (
        <EmptyState onPick={() => fileRef.current?.click()} onSample={loadSamples} issues={issues} />
      ) : (
        <div className="main-grid">
          <div className="col col-left">
            <SessionList
              trajectories={trajectories}
              cards={cards}
              selectedId={selected.id}
              onSelect={(id) => {
                setSelectedId(id)
                setSelectedStep(null)
              }}
              onAdd={() => fileRef.current?.click()}
              onClear={clearAll}
            />
          </div>

          <div className="col col-center">
            <ScorePanel
              card={selectedCard}
              trajectory={selected}
              ruleIssueCount={selectedCard.ruleIssues.length}
            />
            <Timeline
              trajectory={selected}
              card={selectedCard}
              selectedStep={selectedStep}
              onSelectStep={setSelectedStep}
            />
          </div>

          <div className="col col-right">
            <Inspector
              trajectory={selected}
              step={selectedStepData}
              card={selectedCard}
              dimensions={pack.dimensions}
              annotations={annotations}
              onAnnotate={addAnnotation}
              onRemoveAnnotation={removeAnnotation}
            />
            <FindingsPanel
              card={selectedCard}
              dimensions={pack.dimensions}
              onLocate={(index) => setSelectedStep(index)}
            />
          </div>
        </div>
      )}

      <RuleDrawer
        open={drawerOpen}
        pack={pack}
        ruleIssues={activeRuleIssues}
        onClose={() => setDrawerOpen(false)}
        onApply={(next) => {
          applyPack(next)
          setDrawerOpen(false)
        }}
      />

      {toast && <div className="toast">{toast}</div>}
      {dragging && <div className="drag-overlay">松手即导入 · 全程本地解析</div>}
    </div>
  )
}
