# ADR-0012 对比报告：同一套 diff，两个出口

- 状态：已采纳
- 日期：2026-10-22

## 背景

对比视图只在屏幕上存在，结论无法离开工具——改 prompt 的 A/B 结论要贴进 PR、周报、
评审记录，都得靠截图。而「截图里的数字」既不可diff，也不能被 CI 消费。

## 决定

1. **复用，不另写。** 对比报告调用 `compareCards` / `diffFindings` / `alignSteps`，
   与界面视图**同一份 diff 计算**。界面上看到的 `-26`，报告里必然也是 `-26`。
2. **两个出口，一份内容。** UI 用 `downloadFile` 直接下载 Markdown；CLI 用
   `--compare` 写 `compare.md` / `compare.json`。两者都走 `buildComparisonReport`。
3. **Markdown 给人，JSON 给机器。** JSON 的键是契约（`score`、`findings.added`、
   `steps.changed`），不随语言变化；可读标签随 `locale`。这与 ADR-0006 同一条线。
4. **CLI 对比模式：数量必须是 2。** 少一条或多一条都直接报错，不做「取前两条」这种
   猜测——猜错一次，结论就错一次。
5. **门禁只卡对照。** `--fail-below` 在对比模式下只判「对照」那一份：基准是旧版本，
   要求旧版本达标没有意义。
6. **对比模式不产出逐会话报告。** 同时写 `report.md` 与 `compare.md` 会让读者分不清
   以哪份为准；一份任务一份产物。

## 取舍

- 为什么不做 HTML 报告：Markdown 能进 PR、能进知识库、能 diff；HTML 需要托管。
- 为什么步骤表默认只写前 40 行：报告是给人读的，不是给机器全量比对的；全量在 JSON 里。
- 为什么等级行的「变化」写 `—`：等级不是可减量，`A → D` 减 46 分是错的语义。
- 已知边界：报告不含人工标注（标注属工作区状态），与 ADR-0010 一致。

## 后果

- `buildComparisonReport` / `buildComparisonJson` 进 `src/lib/report.ts`，
  与逐会话报告共享转义、本地化与时间格式工具。
- CLI 新增 `--compare`；`examples/healthy.json` + `examples/tool-failure.json`
  可直接产出示例对比。
- 测试：报告 3 项（中文结构、英文与截断、JSON 契约）、CLI 3 项（产物、数量校验、
  只卡对照）、组件 1 项（点击导出真拿到 Markdown）、冒烟 3 项。
- 修掉一处真缺陷：表头误用带 `{label}` 的「基准：{label}」文案，导致报告里出现未替换占位符。
