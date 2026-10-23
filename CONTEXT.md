# CONTEXT — 轨迹质检台

单文件 Agent 轨迹质检工具。所有解析、质检与评分在浏览器内完成，文件不出本机。

## 领域词汇

| 术语                            | 含义                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| **轨迹（Trajectory）**          | 一次 Agent 运行的完整消息序列，含 meta（模型、起止时间、token）。           |
| **步（Step）**                  | 轨迹中的一条消息，已归一为 `role / text / reasoning / toolCalls / result`。 |
| **工具调用（ToolCall）**        | 助手发起的调用；`argsValid` 为 false 表示参数不是合法 JSON。                |
| **工具结果（ToolResult）**      | 由 tool 消息承载的返回值；`isError` 来自显式标记或 `Error:` 前缀。          |
| **配对（Pairing）**             | 用 call id 把结果挂回调用；没有 id 时才按函数名兜底，悬空 id 只报告不猜。   |
| **发现（Finding）**             | 一次规则命中：规则 id、维度、严重度、步号、证据、扣分。                     |
| **维度（Dimension）**           | 质检口径，带权重与颜色；默认四维：结构 / 执行 / 效率 / 语义。               |
| **规则（Rule）**                | 数据：`scope + expr + message`，不含代码。                                  |
| **规则包（RulePack）**          | 维度 + 规则 + 版本，可在界面内编辑、导入导出。                              |
| **评分卡（ScoreCard）**         | 派生结果：维度分、加权分、封顶分、等级、问题计数。                          |
| **错误封顶（Error gate）**      | 按「不同 error 级规则数」限制总分：≥1→74、≥3→54、≥5→39。                    |
| **会话分析（SessionAnalysis）** | 一条轨迹的质检产物：指标、发现、规则异常、耗时诊断。                        |
| **工作区（Workspace）**         | 会话集合 + 选中态 + 规则包 + 人工标注 + 导入问题。                          |
| **分析端口（Analyzer port）**   | `analyze(request, signal)`；同步 adapter 与 worker adapter 两个实现。       |

## 不变量

1. 只有 `analyze()` 能把原始文本变成 `SessionAnalysis`；UI 不得直接调用 parse / metrics / rules / score。
2. 每条 Finding 都必须指向一个已定义的维度；规则包在应用前必须通过契约校验。
3. 评分卡永远派生，不落库；标注或规则包一变，所有分数立即重算。
4. 持久化数据一律带 `schemaVersion`，读取时迁移；损坏数据降级为默认值并记录事件。
5. 单条坏轨迹、单条坏规则、单个面板崩溃都不得影响其余部分。
6. 估算 token 必须带 `estimated: true`，报告中要注明。

## 模块地图

```
src/core/     纯领域：model / expr / parsing / rules / analysis / sample
src/app/      编排：telemetry / persistence / ingest / workspace / analyzer / exporters
src/ui/       表现：App + panels + drawers + ErrorBoundary + controller hook
src/workers/  分析线程（Vite ?worker&inline，单文件内联）
src/lib/      格式化与报告文本
```

### 命令行（`src/cli`）

| 文件         | 职责                                                          |
| ------------ | ------------------------------------------------------------- |
| `args.ts`    | 参数解析，错误以 `UsageErrorCode` 返回（不含文案）            |
| `collect.ts` | 目录递归展开、跳过依赖/隐藏目录、超限即失败                   |
| `batch.ts`   | 逐文件 `analyze` + 评分 + 两份报告 + 门禁判定（只算，不打印） |
| `summary.ts` | 终端表格与帮助（CJK 按两列对齐）                              |
| `main.ts`    | 参数 → 收集 → 批处理 → 打印/落盘 → 退出码                     |
| `bin.ts`     | 进程边界：argv、`process.exitCode`、未捕获异常                |

规则包：内置中文包为默认；`packs/builtin-en.json` 是结构完全等价的英文包，
`--pack en` 直接选用（界面可从规则抽屉导入同一份文件）。翻译只改文案，
`id / expr / severity / scoreImpact` 与中文包逐条一致，由 `packs.test.ts` 按住。

```bash
pnpm build:cli                                  # 产出 dist-cli/qa.mjs
node dist-cli/qa.mjs examples                   # 列表 + 结论
node dist-cli/qa.mjs examples --fail-below 90   # CI 门禁（不通过退出 1）
node dist-cli/qa.mjs examples --out ./qa-out --locale en
node dist-cli/qa.mjs examples --pack en --locale en --out ./qa-out   # 全英文报告
```

退出码：`0` 通过、`1` 门禁未通过、`2` 用法/读写/无可分析内容。**空跑必须是 2**——
没有可分析内容却返回 0，等于让门禁永远绿。

### 规则调参（抽屉内）

`src/core/rules/tuning.ts` 是这块的全部逻辑，界面只负责画：

- `numericLiterals(expr)`：找出表达式里的数字常量（跳过字符串与标识符）。
- `replaceLiteral(expr, index, next)`：原位替换；**替换后必须仍能编译**，否则返回 `null`。
- `buildTuningReport(sessions, pack)`：用草稿包真跑所有轨迹，给出每条规则的命中数、
  覆盖轨迹数、禁用后的平均/最大涨幅，以及表达式出错的规则。

界面侧只改草稿、不直接生效：试错不留痕，「校验并应用」仍是唯一入口。
试跑重算走 `useDeferredValue`，大轨迹下打字不会被卡。

### 轨迹对比

顶栏「对比」（需 ≥2 条轨迹）进入对比模式：左侧会话列表保留，中右两列合并。

- `core/compare.ts`：`compareCards`（分数/维度/步数/token 增量）、
  `diffFindings`（新增 / 已修复 / 仍在）、`alignSteps`（按 `角色|工具名` 做 LCS 对齐，
  内容差异用 FNV-1a 指纹判定）、`summarizeAlignment`。
- 对齐上限 `(n+1)(m+1) > 400_000` 时退化为按位置配对，**不假装对齐过**。
- 只有一条轨迹时不进对比，直接提示「至少两条」。
- 深链：`?compare` 打开对比（配合 `#demo` 载入示例）。

### 语义复核（可选，仅命令行）

`src/core/semantic/`：`prompt`（摘要 + 输出契约）、`parse`（容错解析）、`judge`（超时/重试/取消）、
`merge`（并入 `semantic` 维度，error 10 / warn 6 / info 3）。

```bash
export TQA_LLM_URL=https://api.example.com/v1/chat/completions
export TQA_LLM_MODEL=your-model
export TQA_LLM_API_KEY=...            # 只从环境变量读，不接受 --api-key

node dist-cli/qa.mjs traces --semantic-dry-run      # 只看提示词，不调用模型
node dist-cli/qa.mjs traces --semantic --fail-below 80
```

- 类别：`off_topic / unsupported_claim / overreach / incoherent / unsafe`，标题随语言翻译，
  `reason` 与 `quote` 是模型原文（不翻译）。
- 预算：`--semantic-limit`（默认 20 会话）、单会话最多 8 条；超长轨迹压到 120 步，
  优先保留工具出错/未配对的步。
- 失败降级：单次调用失败只记 issue，整批继续、退出码不变。
- **界面不接模型**：守住离线承诺、CORS 与密钥托管三条线（ADR-0011）。

### 对比报告

同一份 diff 两个出口：界面「导出对比」下载 Markdown；CLI `--compare` 写
`compare.md` / `compare.json`。两者都调 `buildComparisonReport`（`src/lib/report.ts`），
与对比视图共用 `core/compare`，数字不会分叉。

```bash
node dist-cli/qa.mjs a.json b.json --compare --out ./cmp        # 第一份为基准
node dist-cli/qa.mjs a.json b.json --compare --fail-below 80    # 只卡「对照」
```

- 对比模式要求**恰好两条**可分析轨迹，多一条少一条都报错。
- 对比模式只产出 `compare.md` / `compare.json`，不再写逐会话报告。
- 报告不含人工标注（与 ADR-0010 一致）。

### 会话命名与备注

- 存 `{ trajectoryId, name, note }`（`tqa.session-notes`），**按 trajectory.id 索引**，
  重新导入同一份轨迹名字仍在；空名称 + 空备注即删除记录（恢复原名）。
- 只影响展示与报告，不改 `trajectory.label`：`labelOf()` / `noteOf()` 是唯一取法。
- 生效范围：会话列表、评分面板标题、对比下拉、Markdown/JSON 报告。CLI 无工作区，
  仍用文件名。
- 入口：列表项右侧铅笔按钮或双击条目；`Esc` 取消，`保存` 提交。
- **标签**（可选 `tags`）：编辑器内逗号分隔输入；行内 chips + 列表头筛选 chips
  （按出现次数排序）。标签只做组织，不进评分与报告；重命名/批量命名均保留标签。

### 批量选择

面板标题右侧「选择」进入选择态：勾选行 → 底部出现批量条 → 批量命名 / 删除所选。

- 命名规则：前缀 + 起始序号 + 补零位数（`buildBatchNames`，纯函数），实时预览；
  空前缀退化为纯序号，补零上限 6 位。
- `note/batch` 一次合并多条并 trim；空值 = 这条不要名字（与单条编辑同义）。
- 删除需**二次确认**（按钮第一次变成「确认删除 N 条」）；删完自动退出选择态。
- `session/remove` 重新落点：保留原选中项，被删则落到剩余第一条，全删回 `idle`。
- 选择态是临时 UI 状态，不进 reducer、不持久化、不影响评分与导出。

### 报告建议

`core/rules/advice.ts`：`buildAdvice(findings, locale, limit = 6)`，把命中的规则翻成
可执行动作（`advice.<ruleId>`，共 28 条）。

- **只给能说清「怎么改」的规则写**；没有映射就不出条目，不用「请注意优化」兜底。
- 同一规则只出一次，按严重度 → 次数排序，最多 6 条；≥2 次才标「N 处」。
- 逐会话报告在「问题清单」后出 `### 建议`；对比报告只对「对照新增」的问题出建议。
- 建议文案走 i18n 而非规则包：它表达「工具的判断」，不是「规则的数据」。

### HTML 报告

第三种产物：`lib/report-html.ts` 的 `buildHtmlReport`，单文件、自包含、**零脚本**
（折叠用 `<details>`），所有外部文本 `escapeHtml`。视觉沿用应用令牌，
`@media print` 翻成浅色（打印 / 存 PDF 可用）。

- 出口：顶栏「HTML 报告」按钮；CLI `--format html`（只写 `report.html`）、
  `--format all`（md + json + html）。
- 与 Markdown / JSON 同源（同一 `ReportInput`），三份数字不会分叉。
- 对比报告同样有 HTML：`buildComparisonHtml`（`comparison-html.ts`），
  界面对比面板「HTML」按钮 / CLI `--compare --format html` 写 `compare.html`；
  共享样式在 `report-style.ts`，两份报告同一副面孔（ADR-0016）。
- `ReportBundle.html` 随会话数线性增长；三条约 20 KB。

### 规则包变体

抽屉「变体」区：把**当前草稿**（含未应用的调参）存成命名变体，随时一键切回。

- 存 `tqa.pack-variants`（同信封、逐条校验、上限 20）；存的是深拷贝。
- 「生效中」按内容判定：`variant/save|apply` 设置，`pack/apply`（手改包）清空；
  删变体不动当前包；`workspace/clear` 不清变体（ADR-0017）。
- 变体只在界面；CLI 仍走 `--pack <文件>`，从抽屉导出即得同一格式。
- **打包迁移**：`打包导出` / `导入变体` 产出与读取 `tqa-variants` 信封
  （`serializePackVariants` / `parsePackVariants`，容忍裸数组、逐条校验）；
  导入同 id 覆盖、整块置顶，超上限整体拒绝。

### 口径对比

抽屉「口径对比」：当前包 / 内置中文包 / 各变体两两对跑同一批轨迹。

- `core/pack-compare.ts`：`scoreUnderPack`（真跑规则）与 `comparePacks`（逐会话分数 + 双平均 + identical 判定）。
- 与调参/CLI 同一边界：不含人工标注。
- 注意：存变体即生效，因此「当前包 vs 刚存的变体」恒等——比较变体与原版的正确姿势是
  基准选「内置中文包」（或另一变体）。identical 时界面如实说明，不出空表。
- 报告出口：`lib/pack-compare-report.ts` 生成 Markdown/JSON（键名稳定，含 `average.delta`）；
  抽屉「导出对比」按钮；CLI `--pack-compare <包|en|zh>` 写 `pack-compare.md/json`
  并打印均值行，与 `--compare` 互斥。

## 质量门槛

`pnpm verify` = typecheck + lint + 覆盖率测试 + 构建。覆盖率门槛：行/函数/语句 ≥85%，分支 ≥75%。
四条示例轨迹的分数与问题清单由 `src/core/__golden__/samples.json` 锁定。
样式分四层（tokens / base / layout / components），只允许上层引用下层变量，不靠权重压制。
交互元素均可键盘到达；抽屉有焦点陷阱与 Esc 关闭；动效尊重 `prefers-reduced-motion`。
性能基线：1k 步 < 500ms、10k 步 < 3s（实测约 20ms / 98ms）。
时间线 > 400 步切紧凑虚拟滚动（固定行高 46px），概览条降采样至 ≤180 段。
调试深链：`#demo` / `#demo:N` 载入示例，`#stress:N` 生成 N 步合成轨迹，`?drawer=1`、`?diag=1` 打开抽屉。

## 多语言

- `src/i18n`：中文为源语言，`MessageKey` 由中文键集推导；英文是 `Record<MessageKey, string>`，缺键**编译失败**。
- 插值 `{name}`；两语言的占位符集合由测试强制一致；未知键回落为键名，便于定位。
- locale 优先级：本地存储 > 系统语言（`zh*` → 中文，其余 → 英文）> 中文；切换时同步 `<html lang>` 并持久化。
- **边界**：规则包内的规则标题与提示属「数据」，不随界面语言翻译；要英文质检结论需导入英文规则包。
- 进度：字典/Provider、界面接线、**报告本地化**均已完成；顶部可切换 中文 / EN，`?lang=en` 可深链演示。
- 代码分层：`src/i18n/core.ts` 纯逻辑（字典/插值/探测/`labelFor`/`formatDateTime`），
  `src/i18n/index.tsx` 只管 Provider 与 hooks。报告层与未来 CLI 直接依赖 `core`，不引入 React。
- 报告口径（ADR-0006）：Markdown 全量本地化；JSON **键名稳定**、仅值本地化并带 `locale` 字段；
  规则包文本与包名始终不翻译。

## 持续集成

`.github/workflows/ci.yml`：push 到 main、PR、手动触发；先 `pnpm install --frozen-lockfile`，再 `pnpm verify`。
`verify` 依次是：typecheck → lint → 覆盖率测试 → 文案扫描（`src/ui` + `src/cli`）→ 单文件构建 →
产物契约校验 → CLI 构建 → CLI 冒烟（`scripts/smoke-cli.mjs`）。
产物契约校验（`scripts/check-artifact.mjs`）要求：不得含外部脚本/样式/远程图片，
必须有 `#root`，体积不超过 1500 KB（`ARTIFACT_BUDGET_KB` 可调）。
产物与覆盖率作为 artifact 上传（保留 14 / 7 天）。本地等价入口：`pnpm verify`。
