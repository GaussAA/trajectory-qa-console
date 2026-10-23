# ADR-0016：单文件 HTML 报告

日期：2026-10-23 ｜ 状态：已接受

## 背景

报告已有两个出口：Markdown（贴 PR / 周报）与 JSON（给 CI）。两者都要求读者
「会读表格」。要把质检结论发给不碰命令行的同事——或者打印成 PDF 存档——
Markdown 不够体面，界面截图又没法检索。

## 决定

新增第三种产物：`buildHtmlReport`（`src/lib/report-html.ts`），单文件 HTML，
与 Markdown / JSON 同源（同一份 `ReportInput`），在两个出口可用：

- 界面顶栏「HTML 报告」按钮，直接下载 `trajectory-qa-*.html`；
- CLI `--format html`（写 `report.html`）与 `--format all`（md + json + html）。

三条硬约束：

1. **自包含**：无外部字体、样式、图片；**零脚本**——折叠用 `<details>`，
   不在别人的浏览器里执行任何代码。
2. **全量转义**：轨迹名、工具名、模型输出都是外部数据，一律 `escapeHtml`；
   有专门用例注入 `<script>` 与 `<img onerror>` 并断言产出里只有转义形态。
3. **复用报告层的数据**，不复用其文本：HTML 不解析 Markdown，而是直接读
   `entries`（分数、维度、findings、advice），保证与界面、Markdown 三者数字一致。

## 视觉

沿用应用的设计令牌（深色液态玻璃），分数用 conic-gradient 环，
维度用进度条；`@media print` 整体翻成浅色并 `break-inside: avoid`，
「打印 / 存 PDF」直接可用。**踩过的坑**：分数环的内遮罩是深色实心，
打印态不改就会在白纸上印出一块黑饼；表格首列用了浅色文字，白纸上不可见——
两处都在打印块里显式覆盖，并有截图核对。

## 修订（同日）：对比报告也出 HTML

原决定「对比报告暂不出 HTML」在当天即被推翻——出口都齐了，唯独对比不能外发，
反而是最常被问「能不能发我看看」的场景。已落地 `buildComparisonHtml`
（`src/lib/comparison-html.ts`）：

- 与 Markdown 对比报告同一份 `ComparisonInput`，直接读 `core/compare` 的 diff，
  不从 Markdown 做文本替换；
- 双分数环 + 差值徽章、维度增量表、问题三分（新增/已修复/仍在）、
  步骤差异表、只针对「对照新增」的建议；
- 共享样式抽到 `src/lib/report-style.ts`（STYLE / escapeHtml / toneOf / clampPercent），
  两份报告长同一副面孔，不存在第二套设计令牌。

出口：界面对比面板新增「HTML」按钮；CLI `--compare --format html` 写 `compare.html`，
`--format all` 时 md + json + html 三份齐出。`cli.err.compareNoHtml` 已删除。

## 取舍

- HTML 体积随会话数线性增长（三条约 20 KB），超长轨迹的证据摘录按既有
  截断规则处理；暂不加分页。

## 后果

- `ReportBundle` 多出 `html` 字段；顶栏多一个按钮（1280px 宽度下仍排得下，已截图核对）。
- 覆盖率统计把 `src/lib` 纳入（此前漏了报告层），lib 现为 94.8% 行 / 90.2% 分支。
- 测试 295 项；CLI 冒烟新增「html 是唯一产物、自包含、无脚本」断言。
