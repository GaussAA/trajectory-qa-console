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

## 取舍

- **对比报告暂不出 HTML**：`--compare --format html` 明确报错
  （`cli.err.compareNoHtml`），宁可拒绝也不写一个残缺的半成品；后续如需要，
  应作为独立的对比 HTML 生成器，而不是在 Markdown 里做文本替换。
- HTML 体积随会话数线性增长（三条约 20 KB），超长轨迹的证据摘录按既有
  截断规则处理；暂不加分页。

## 后果

- `ReportBundle` 多出 `html` 字段；顶栏多一个按钮（1280px 宽度下仍排得下，已截图核对）。
- 覆盖率统计把 `src/lib` 纳入（此前漏了报告层），lib 现为 94.8% 行 / 90.2% 分支。
- 测试 295 项；CLI 冒烟新增「html 是唯一产物、自包含、无脚本」断言。
