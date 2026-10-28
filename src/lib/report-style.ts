/** 报告（逐会话与对比）共享的视觉与转义工具。
 *
 *  两份 HTML 报告必须长同一副面孔：这里只放「视觉事实」，
 *  各生成器只往里填数据，避免出现第二套设计令牌。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 分数决定强调色：跟应用里的等级语义保持一致。 */
export function toneOf(score: number): string {
  if (score >= 90) return '#5eead4'
  if (score >= 75) return '#34d399'
  if (score >= 60) return '#fbbf24'
  return '#fb7185'
}

export function clampPercent(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

export const STYLE = `
:root {
  color-scheme: dark;
  --bg: #06080f;
  --panel: rgba(19, 25, 40, 0.56);
  --line: rgba(148, 163, 184, 0.12);
  --text: #e9eef8;
  --dim: #a8b3c7;
  --mute: #6f7a92;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 24px 64px;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  background:
    radial-gradient(900px 620px at 8% -12%, rgba(94, 234, 212, 0.11), transparent 62%),
    radial-gradient(820px 520px at 92% -6%, rgba(167, 139, 250, 0.13), transparent 58%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 960px; margin: 0 auto; }
.eyebrow {
  margin: 0 0 6px;
  font-size:$211px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--mute);
}
h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
h2 { margin: 0 0 10px; font-size: 17px; font-weight: 600; }
h3 {
  margin: 22px 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mute);
}
p { margin: 0 0 8px; }
.masthead { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-end; justify-content: space-between; padding-bottom: 22px; }
.meta { color: var(--dim); font-size: 12.5px; margin: 0; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 6px 0 26px; }
.kpi {
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--panel);
}
.kpi span { display: block; font-size:$211px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mute); }
.kpi b { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.block, .session {
  margin-bottom: 22px;
  padding: 20px 22px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--panel);
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left;
  font-size:$211px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mute);
  font-weight: 500;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
td { padding: 7px 8px; border-bottom: 1px solid rgba(148, 163, 184, 0.06); color: var(--dim); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.name { color: var(--text); }
.session { scroll-margin-top: 16px; }
.session-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "eyebrow score" "title score" "chips score";
  grid-template-rows: auto auto 1fr;
  column-gap: 18px;
  align-items: start;
  cursor: pointer;
  list-style: none;
}
.session-head::-webkit-details-marker { display: none; }
.session-head .eyebrow { grid-area: eyebrow; }
.session-head h2 { grid-area: title; min-width: 0; }
.session-head .chips { grid-area: chips; }
.session-head .score { grid-area: score; }
/* 原生三角在 grid 下会消失，用边框画一个，并随开合旋转。 */
.session-head .eyebrow::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 8px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s;
  vertical-align: 1px;
}
details[open] > .session-head .eyebrow::before,
details:target > .session-head .eyebrow::before { transform: rotate(45deg); }
/* 从总览表跳过来时，被收起的会话也要把内容露出来；不需要脚本。 */
details:target::details-content { content-visibility: visible; display: block; }
.session-head:focus-visible, td.name a:focus-visible { outline: 2px solid #5eead4; outline-offset: 3px; border-radius: 6px; }
td.name a { color: inherit; text-decoration: underline dotted; text-underline-offset: 3px; }
td.name a:hover { color: var(--text); text-decoration-style: solid; }
@media (prefers-reduced-motion: reduce) { .session-head .eyebrow::before { transition: none; } }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(148, 163, 184, 0.06);
  font-size:$211px;
  color: var(--dim);
  white-space: nowrap;
}
.score {
  flex: 0 0 auto;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  display: grid;
  place-content: center;
  text-align: center;
  background:
    radial-gradient(closest-side, #0a0f1a 85%, transparent 86%),
    conic-gradient(var(--tone) calc(var(--pct) * 1%), rgba(148, 163, 184, 0.16) 0);
}
.score b { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.score em { font-size:$211px; font-style: normal; color: var(--dim); }
.dims { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.dim {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 34px 40px;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--dim);
}
.dim-name { color: var(--text); }
.dim-bar { height: 5px; border-radius: 999px; background: rgba(148, 163, 184, 0.12); overflow: hidden; }
.dim-bar i { display: block; height: 100%; border-radius: 999px; }
.dim-score { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }
.dim-lost { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mute); }
.findings, .advice, .issues { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.finding {
  padding: 10px 12px 10px 14px;
  border-left: 2px solid var(--mute);
  border-radius: 0 10px 10px 0;
  background: rgba(148, 163, 184, 0.04);
}
.finding.sev-error { border-left-color: #fb7185; background: rgba(251, 113, 133, 0.06); }
.finding.sev-warn { border-left-color: #fbbf24; background: rgba(251, 191, 36, 0.05); }
.finding.sev-info { border-left-color: #60a5fa; background: rgba(96, 165, 250, 0.05); }
.finding-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.sev { font-size:$211px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute); }
.sev-error .sev { color: #fda4af; }
.sev-warn .sev { color: #fcd34d; }
.sev-info .sev { color: #93c5fd; }
.rule { font-weight: 600; font-size: 13.5px; }
.finding-body { margin: 4px 0 0; color: var(--dim); font-size: 12.5px; }
.evidence {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(6, 10, 18, 0.55);
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.advice { counter-reset: advice; }
.advice li {
  position: relative;
  padding: 6px 0 6px 26px;
  color: var(--dim);
  font-size: 13px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
}
.advice li::before {
  counter-increment: advice;
  content: counter(advice);
  position: absolute;
  left: 0;
  top: 6px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: grid;
  place-content: center;
  font-size:$211px;
  color: #06231f;
  background: #5eead4;
}
.advice .chip { margin-left: 6px; }
.issues li { font-size: 12.5px; color: var(--dim); }
.issues code { font-family: var(--mono); font-size: 11.5px; color: #fcd34d; }
.empty { color: var(--mute); font-size: 13px; }
.note {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(251, 191, 36, 0.07);
  border: 1px solid rgba(251, 191, 36, 0.2);
  color: #fcd34d;
  font-size: 12px;
}
.masthead .score em { color: var(--mute); }
footer {
  margin-top: 30px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--mute);
  font-size: 11.5px;
  line-height: 1.7;
}
@media (max-width: 720px) {
  body { padding: 24px 14px 40px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .session-head { grid-template-columns: minmax(0, 1fr); grid-template-areas: "eyebrow" "title" "chips" "score"; }
  .session-head .score { justify-self: start; margin-top: 12px; }
  .dim { grid-template-columns: 92px minmax(0, 1fr) 30px 34px; }
}
@media print {
  :root { color-scheme: light; }
  body {
    background: #fff;
    color: #111827;
    padding: 0;
    font-size: 11.5pt;
  }
  .page { max-width: none; }
  .kpi, .session, .block { background: #fff; border-color: #d7dee9; break-inside: avoid; }
  /* 分数环的内遮罩是深色实心：不改就会在白纸上印出一块黑饼。 */
  .score {
    background:
      radial-gradient(closest-side, #fff 85%, transparent 86%),
      conic-gradient(var(--tone) calc(var(--pct) * 1%), #e5e7eb 0);
  }
  .score b, .score em { color: #111827; }
  td.name { color: #111827; }
  h1 { color: #111827; }
  h2, h3, .dim-name, .rule, .dim-score { color: #111827; }
  td, .finding-body, .advice li, .meta, .chip, .issues li, .empty { color: #374151; }
  .chip { border-color: #d7dee9; background: #f3f5f9; }
  .finding { background: #f8fafc; border-left-color: #94a3b8; }
  .finding.sev-error { background: #fff1f2; border-left-color: #e11d48; }
  .finding.sev-warn { background: #fffbeb; border-left-color: #d97706; }
  .finding.sev-info { background: #eff6ff; border-left-color: #2563eb; }
  .evidence { background: #f8fafc; border-color: #e2e8f0; color: #334155; }
  .sev, .sev-error .sev, .sev-warn .sev, .sev-info .sev, .eyebrow { color: #4b5563; }
  .advice li::before { background: #0f766e; color: #fff; }
  /* 关着的 <details> 默认不会被打印；这里让每个会话的内容都印出来。 */
  details::details-content { content-visibility: visible; display: block; }
  .session-head .eyebrow::before { display: none; }
  td.name a { text-decoration: none; }
  footer { border-color: #d7dee9; color: #4b5563; }
}
`
