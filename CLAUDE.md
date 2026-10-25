# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Trajectory QA Console (轨迹质检台): an offline QA tool for agent trajectories (OpenAI messages / tool_calls). One TypeScript core ships two ways: a React UI built into a single self-contained `dist/index.html`, and a Node CLI bundled into `dist-cli/qa.mjs`.

**Read [CONTEXT.md](CONTEXT.md) before non-trivial changes.** It holds the domain glossary, the numbered invariants and per-feature design notes. [docs/adr/](docs/adr/) records why things are the way they are; check the relevant ADR before reversing a decision. Docs, code comments and commit subjects are in Chinese.

## Commands

Node ≥ 22, pnpm.

```bash
pnpm dev                     # Vite dev server
pnpm build                   # tsc --noEmit + vite build → dist/index.html only (NOT the CLI)
pnpm build:cli               # → dist-cli/qa.mjs
pnpm typecheck
pnpm lint                    # oxlint --deny-warnings, so warnings fail too
pnpm format                  # prettier --write

pnpm test                                   # all tests, once
pnpm test src/core/expr.test.ts             # one file
pnpm test -t "golden master"                # by test name
pnpm test:watch
pnpm test:coverage                          # enforces lines/functions/statements ≥85%, branches ≥75%

pnpm verify                  # the merge gate; CI and release both run exactly this
pnpm test:e2e                # Playwright against dist/index.html opened via file://; needs `pnpm build` first and a local Chrome. CI runs it after verify; it is not part of verify
```

`pnpm verify` runs, in order: typecheck → lint → format:check → test:coverage → `scripts/check-i18n.mjs` → `scripts/check-typography.mjs` → vite build → `scripts/check-artifact.mjs` → build:cli → `scripts/smoke-cli.mjs`. Each script can be run alone with `node scripts/<name>.mjs`; the artifact check and the CLI smoke test need their build output to exist first. A formatting failure is fixed with `pnpm format`.

CLI usage once built: `node dist-cli/qa.mjs examples [--fail-below 90] [--out dir] [--format md|json|html|both|all] [--locale en] [--pack en]`. Exit codes are a contract (ADR-0007): `0` pass, `1` gate failed, `2` usage/IO error, nothing to analyse, **or any partial failure**. The LLM features (`--semantic`, `--agent`, `serve`) read `TQA_LLM_URL` or `TQA_LLM_BASE_URL`, `TQA_LLM_MODEL` and `TQA_LLM_API_KEY` from the environment only. `--semantic-dry-run` and `--agent-dry-run` print the prompt without calling a model.

## Testing notes

- Vitest's default environment is `node`. Component and DOM tests opt in with a first-line `// @vitest-environment jsdom` comment.
- Coverage counts `src/core`, `src/app`, `src/lib`, `src/cli`, `src/i18n` and `src/ui/windowing.ts` only. Other `src/ui` code is tested but not measured.
- `src/core/analysis/golden.test.ts` locks the scores, findings and messages of the four demo traces against `src/core/__golden__/samples.json`. A deliberate change to rules, scoring or wording means editing that JSON by hand; no regeneration script exists.
- `src/core/rules/packs.test.ts` requires `packs/builtin-en.json` to match the Chinese default pack (`builtin-pack.ts`) rule for rule: same ids, order, `expr`, `severity`, `scoreImpact` and `{placeholders}`, with only the text translated. Change both together. The JSON file is the English pack's only source; `builtin-pack-en.ts` just validates and re-exports it.

## Architecture

Layering. Lower layers never import higher ones:

- `src/core/` holds the pure domain code: no React, DOM or storage. `model.ts` is the shared vocabulary, so name a new concept there first. `core/llm/` is the only place with LLM transport, timeouts, retries and response parsing, shared by `core/semantic/` and `core/agent/`.
- `src/app/` orchestrates: the workspace reducer, persistence, ingest, telemetry, the analyzer port and exporters.
- `src/ui/` is the React layer. `useWorkspaceController.ts` is the single wiring point (reducer + analyzer + persistence + telemetry). Components get plain data and callbacks.
- `src/lib/` renders reports (Markdown, JSON, HTML, agent and comparison reports) and formats values.
- `src/cli/`: `bin.ts` is the process boundary, `main.ts` orchestrates, and `batch.ts` computes without printing.
- `src/i18n/core.ts` has no React dependency, so `lib/` and the CLI use it directly. `index.tsx` holds the Provider and hooks.

The pipeline and the rules that keep it consistent:

- **`analyze()` (`core/analysis/index.ts`) is the only path from raw text to `SessionAnalysis`**, which holds trajectory, metrics and diagnostics. It isolates failures per session: a bad session goes into `issues`, and the file fails only if every session fails. The UI calls it through the analyzer port (`app/analyzer.ts`). That port uses the sync adapter, or an inlined Web Worker for inputs over 256 KB. The worker is skipped on `file://`. The port falls back to sync only on a real worker fault (could not start, crashed, went silent); an `analysis-failed` that came back from `analyze()` is about the data and does not disable the worker.
- **`buildCard(trajectory, metrics, pack, annotations)` is the only source of a score.** Findings and score cards are never stored. Rules re-run on every call, which costs about 10 ms per 10k steps, and callers memoise instead of caching. The workspace, pack comparison (`scoreUnderPack`), the CLI and the agent tools all call it, so one input can never show two different scores.
- Rules are data (`scope + expr + message`). `core/expr.ts` compiles them to an AST and walks it; never use `eval` or `new Function`. `core/rules/contract.ts` validates packs with zod and declares a type for every rule-visible field. Validation is strict: unknown keys at any level, and `{placeholders}` in a message that are not fields of the rule's scope, are errors. When you add a field to `StepContext` or `TrajectoryMetrics`, also add it to `STEP_FIELD_TYPES` or `TRAJECTORY_FIELD_TYPES`. Both are `Record<keyof …>`, so a missing entry fails typecheck. Scoring caps the total by the number of distinct error-level rules hit: ≥1 → 74, ≥3 → 54, ≥5 → 39 (ADR-0003).
- Reports: Markdown, JSON and HTML are rendered from the same `ReportInput` (`lib/report.ts`). Totals come from `reportTotals` and comparison diffs from `buildComparisonModel`, each computed once, so the three formats and the UI and CLI outputs always agree. JSON keys stay stable and only values are localised (new keys may be added, existing ones keep their meaning). HTML reports contain no `<script>` and escape all external text.
- LLM boundaries: the browser UI never calls a model. Semantic review runs in the CLI only. The UI reaches agent diagnosis only through `qa serve` (127.0.0.1, CORS allowlist), which keeps the API key in the server process. **Agent output never enters the `ScoreCard` or report bundle** (invariant 7). Everything sent to a model is redacted first (`redactSecrets` / `redactJsonText` in `core/analysis/privacy.ts`), and a semantic finding whose quote is not in the digest the model saw is downgraded and marked unverified. Agent proposals are drafts, and the UI adopts one through the single `pack/adopt` action.
- Persisted data carries a `schemaVersion`. To add a version, append one entry to the `MIGRATIONS` table in `app/persistence.ts`. Data from a future version is rejected and its key is locked against writes for the session, so an older build cannot overwrite what a newer one saved. Corrupt data falls back to defaults.

## Conventions enforced by `pnpm verify`

- **No hardcoded CJK or fullwidth punctuation in `src/ui`, `src/app`, `src/cli` or `src/lib`** outside comments (`check-i18n.mjs`). User-facing text goes in `src/i18n/locales/zh-CN.ts`, the source of `MessageKey`, and in `en.ts`, typed `Record<MessageKey, string>` so a missing key fails to compile. Both locales must use the same `{name}` placeholders. `src/core` messages are deliberately exempt; the UI and CLI override them with `t('error.<code>')`.
- **Font sizes come only from the six `var(--fs-*)` tokens** in `src/styles/tokens.css` (minimum 11px). Raw `font-size: Npx` in CSS or inline `fontSize: 'Npx'` in TSX fails `check-typography.mjs`, as do unbalanced braces in any stylesheet.
- The exported HTML reports in `src/lib` carry their own stylesheet and cannot use `var(--fs-*)`, but `check-typography.mjs` holds them to the same 11px floor. The build must stay one self-contained file under 1500 KB, with no external scripts, stylesheets or remote images. The CLI bundle may import only `node:` built-ins.
- The linter (oxlint, configured in `oxlint.config.js`) forbids `any`, allows only `console.warn` and `console.error` outside tests, and ignores unused names only when they start with `_`. tsconfig turns on `noUncheckedIndexedAccess`. Prettier settings: no semicolons, single quotes, 110-character lines.

- **Layer direction is a lint rule.** `oxlint.config.js` (`layerOverrides`) forbids upward relative imports, tests included: `core` may not import `app/ui/lib/cli`, `lib` not `app/ui/cli`, `app` not `ui/cli`, `cli` not `ui`, and `i18n` not any other layer. A test that needs a higher layer belongs in that layer's directory. The rule matches relative specifiers by depth (up to `MAX_DEPTH` levels), so keep imports relative. If a layer's directories ever nest deeper than `MAX_DEPTH`, the oxlint config throws instead of silently skipping the deepest files; raise the constant.
- **Shared test builders live in `test-support.ts` files**: `src/core/test-support.ts` (`analyzeSessions`, `reimbursementSessions`, `makeStep`) and `src/cli/test-support.ts` (temp dirs, `capture`, the serve server helpers). Test files only; they are excluded from coverage by the `**/test-support.ts` pattern, and production code must not import them (a lint rule enforces this). A test file that uses `tempDir` must register `afterEach(cleanupTempDirs)` itself.
- **Large CLI test files are split by topic**: `cli/main.test.ts` holds the core flow, with `main.compare`, `main.semantic`, `main.agent` and `main.llm` beside it; `serve.test.ts` holds routing, with `serve.security`, `serve.limits` and `serve.lifecycle`. Put a new case in the file that matches its topic rather than growing `main.test.ts`.

Another convention, not checked by a script: CSS is split into four layers (`tokens` → `base` → `layout` → `components`). Each layer may reference only variables from the layers below it, and conflicts are not resolved by raising specificity.

## Decisions already made

- Do not split `useWorkspaceController` (ADR-0018). Its render-time `stateRef.current = state` assignment is intentional. Revisit only when a second caller needs the same actions.
- The rule drawer's dry-run (`core/rules/tuning.ts`) and pack comparison (`core/pack-compare.ts`) are the documented exceptions where the UI evaluates rules directly. All other UI code must not call parse, metrics or score directly.

## Workflow

- Commits use Conventional Commits with a scope and a Chinese subject that describes the user-visible effect, e.g. `fix(ui): 导出按钮挪到抽屉页脚，关掉面板也不再丢结论`.
- Release: pushing a `v*` tag runs verify and publishes the HTML and CLI artifacts. The tag must equal `v` + `package.json` version, or the release fails.
- UI debug deep links: `#demo` / `#demo:N` load sample traces, `#stress:N` generates an N-step synthetic trace, and `?drawer=1`, `?diag=1`, `?compare`, `?lang=en` and `?agent=http://127.0.0.1:7788` open specific views.
