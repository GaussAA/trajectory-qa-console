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
| **评分派生（buildCard）**       | `(trajectory, metrics, pack, 标注) → 评分卡`。唯一的算分入口，规则在此现算。 |
| **错误封顶（Error gate）**      | 按「不同 error 级规则数」限制总分：≥1→74、≥3→54、≥5→39。74 恰好是 C 的上沿，所以带 error 的 C 标签是「有严重问题」而不是「合格」（`gradeKeyOf`）；字母与分数不变。 |
| **会话分析（SessionAnalysis）** | 一条轨迹的质检产物：指标、发现、规则异常、耗时诊断。                        |
| **工作区（Workspace）**         | 会话集合 + 选中态 + 规则包 + 人工标注 + 导入问题。                          |
| **分析端口（Analyzer port）**   | `analyze(request, signal)`：只做解析与指标，不接规则包；返回 `{ sessions, issues }`。同步/worker 两个 adapter。 |

## 不变量

1. 只有 `analyze()` 能把原始文本变成 `SessionAnalysis`；UI 不得直接调用 parse / metrics / score。**例外**：规则抽屉的「试跑」与「口径对比」由界面主动求值、直接跑 rules（`tuning.ts` / `pack-compare.ts`）——它们回答的是「换一套口径会怎样」，不是这条会话的分数；大轨迹下由 `useDeferredValue` 兜着，打字不被卡。
2. 每条 Finding 都必须指向一个已定义的维度；规则包在应用前必须通过契约校验。
3. 评分卡永远派生，不落库；标注或规则包一变，所有分数立即重算。会话只存与规则包无关的 `trajectory + metrics`，findings 由 `buildCard` 现算——这条因此是**结构上成立**，不是靠记得重算。工作区主路径与「口径对比」共用 `buildCard`，同一份数据不可能显示两个分数。
4. 持久化数据一律带 `schemaVersion`，读取时迁移；损坏数据降级为默认值并记录事件。版本判定在 `persistence.ts`：未来版本（`FutureSchemaVersionError`）拒绝而非误读，迁移链是 `MIGRATIONS` 表——新增版本只加一条，不逐个改 loader。
5. 单条坏轨迹、单条坏规则、单个面板崩溃都不得影响其余部分。坏轨迹由 `analyze` **会话级**隔离：跳过并记入 `issues` 上报，不静默；只有**全部**会话都失败才算这个文件失败。
6. 估算 token 必须带 `estimated: true`，报告中要注明。
7. **智能体诊断不参与打分。** 它的结论只进 `agent.md/json`，不进 `ScoreCard`、不进语义维度、
   不进 `ReportBundle`。分数永远只由 `buildCard` 从「轨迹 + 指标 + 规则包 + 标注」派生——
   接了模型之后这条更要有，否则模型输出的漂移会污染分数，invariant 3 就成了口号。

## 排版基线（2026-10-24 起）

- **字号只有 6 档**：`--fs-xs 11` / `--fs-sm 12` / `--fs-base 13` / `--fs-md 15` / `--fs-lg 19` /
  `--fs-xl 22`。**下限 11px**。样式表里出现裸 `font-size: Npx` 会被
  `scripts/check-typography.mjs` 拦下（已并入 `pnpm verify`）。导出的 HTML 报告（`src/lib`）内嵌自己的
  样式表，拿不到应用的 CSS 变量所以不要求走标度，但同样守这条 11px 下限（此前它有 10px、10.5px 的字）。
- 为什么这么死：改之前 3125 行 CSS 里有 137 处裸字号、其中 94 处小于 11px。这不是审美偏好——
  8.5–10px 的中文在正常视距下读不清，连续看一小时就是成本。
- **弱化色 `--text-mute` 不得低于 4.5:1**（现为 5.16:1）。原先 4.39:1 恰好配着 9px 小字用。
- **键位**：`↑`/`↓`（或 `j`/`k`）逐步查看轨迹。输入框内与抽屉打开时不劫持。
  64 步的轨迹一格格点，审一遍要点十几分钟——这是效率上最大的一处欠账。
- **视觉权重跟优先级走**：满分维度弱化（`dim-full`）、零问题时问题清单收成一行（`is-empty`）、
  原始 JSON 默认折叠。判断标准只有一个：这块面积现在该不该抢注意力。

## 响应式体系（2026-10-24 定）

**两条轴，各管各的**：
- **宽度决定几栏**：≥1280 三栏；1024–1279 左栏收成 56px 图标条；≤1023 单栏堆叠、页面纵向滚动。
- **高度决定每栏多紧凑**：`@media (max-height: 820px)` 分数区压缩（188→136）；
  `≤680px` 再收（分数环 60px、四维让位、时间线优先）。**原先只看宽度，
  1920×720 的时间线只剩 442px，而分数区恒占 188px。**

**组件按自己的容器决策，不按视口猜**：三栏各设 `container-type: inline-size; container-name: col`，
栏内用 `@container col (...)` 排布（四维看**中栏**多宽、图标条看**左栏**多窄）。
视口断点只负责骨架，容器查询负责细节。

**堆叠布局（≤1023）另有一条硬约束**：
堆叠态里 `.col` 变成 block，`.session-panel` 的 `flex: 1` 就失效了，
而它没有高度上限——**会话列表于是随文件数无限长高，内部滚动条永不出现，
还把下面的时间线顶到屏幕外**。所以堆叠态下每块面板都要自己封顶、内部滚：
会话列表 300px（约 5 行，常见场景整份露全）、时间线 62vh、检视器 60vh、问题单 40vh。

**硬约束**：
- **任何宽度都不出横向滚动条**（`min-width` 硬下限已清除）。
- **堆叠态每块面板都有高度上限**（`src/styles/responsive.test.ts` 逐个断言）。
- **大屏有上限**：主网格与顶栏同宽上限 1700px 居中——带鱼屏上不该摊出一行 2734px 的长文。
- **左栏宽度是变量** `--left-w`，窄屏强制 56px、宽屏由用户折叠决定（持久化在 `src/lib/prefs.ts`）。

**两条机器可验的护栏**：
- `src/styles/responsive.test.ts`：断言容器查询（**按文件**断言，不许用别处的充数）、
  高度分档存在、无 500px 以上的 `min-width`、极窄有单栏降级、大屏有上限。
- `.workbuddy/audit-matrix.mjs`：8 组视口实拍 + 4 条判据（无横向滚动 / 时间线能看 6 步 /
  分数区不超屏高 22% / 中栏不窄于 500px），不达标即红。阈值用**步数与占比**，不拍脑袋像素。

## 模块地图

```
src/core/     纯领域：model / expr / parsing / rules / analysis / sample / semantic / agent
src/core/llm/ LLM 底座：transport（可注入）/ complete（超时+重试）/ response（取内容、看形状）
src/app/      编排：telemetry / persistence / ingest / workspace / analyzer / exporters
src/ui/       表现：App + panels + drawers + ErrorBoundary + controller hook
src/workers/  分析线程（Vite ?worker&inline，单文件内联）
src/lib/      格式化与报告文本
```

`core/llm` 单独存在的理由：语义复核与智能体是同一端点、同一密钥、同一套脱敏纪律。
超时/重试/响应解析各只有一份——这个项目已经为「同一件事算两遍」付过四次代价。

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
没有可分析内容却返回 0，等于让门禁永远绿。**部分失败同样是 2**：只要有一条文件没
能分析、或一个路径扫不进去，即使其余全达标也不算通过——“没检查过”不能被算进
“通过”。判定放在写盘之后，以免盖掉真正的写入错误。

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
# 或只给 base（`…/v1` 这类版本尾巴会自动补 /chat/completions；自带路径的代理地址原样使用）
export TQA_LLM_BASE_URL=https://token.sensenova.cn/v1
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

### 智能体诊断（可选，仅命令行，ADR-0019）

`src/core/agent/`：`prompt`（系统提示）、`chat`（一回合）、`tools`（工具集）、`loop`（循环+预算）、
`types`（消息/工具/trace/结论）。出口只有 `runAgent`，报告在 `lib/agent-report.ts`。

```bash
node dist-cli/qa.mjs traces --agent                       # 诊断，产物 agent.md / agent.json
node dist-cli/qa.mjs traces --agent-dry-run               # 只打印系统提示与工具清单，零成本
node dist-cli/qa.mjs traces --agent --agent-rounds 4 --agent-trace ./trace.json
```

- **模型只解释分数，不改分数**：结论进 `agent.*`，与 `report.*` 分开写；不进 `ScoreCard`。
- **数字只能来自工具**：12 个工具全部映射既有纯函数（`buildCard` / `compareCards` /
  `scoreUnderPack` 的同源 `buildCard` / `numericLiterals` / `replaceLiteral` / `validatePack`）。
  报告把「结论（模型归纳，未核验）」与「调用记录（工具产出）」分成两节。
- **步号一律 1 基**：工具参数、工具返回、报告、语义提示词同一个口径。
- **预算硬上限**：8 轮 / 24 次调用 / 180s 墙钟 / 单次 90s / 4096 token。撞上限即停，
  `trace.truncated = true`，报告写「未收敛」并指明是哪个上限——不假装那是完整诊断。
  - **墙钟是真上限**：每一回合（含重试与退避）都按**剩余**墙钟钳制，`complete()` 的
    `totalTimeoutMs` 约束整个调用而不只是单次尝试。否则「单次 90s + 一次重试」最坏 180s，
    套在 180s 总预算里等于没有预算。回合内用完预算算「时长上限」（未收敛），不报成端点故障。
  - **超时不重试**：重试只给 429 / 5xx / 连接层错误。一个超时的请求服务端可能已经收到并计费，
    再发一遍是付两次，多半也只是把同样的慢再等一遍。
  - **输出被截断算未收敛**：`finish_reason: length` 且没有工具调用时，停因是 `output-limit`。
    推理型模型会把 4096 token 花在思考上，留下半句话；半截的话照样交出去，但不能标成「已回答」。
  - **客户端断开即停**：`qa serve` 在响应没写完就断连时 abort 这次运行（页面里点「取消」只是
    abort 浏览器的 fetch，服务端要靠断连才知道）。否则没人在看的请求会继续烧到预算上限。
- **失败保留 trace**：`AgentRun` 不用 `Result` 包装，失败原因(`error`) 与证据(`trace`) 一起返回。
- **工具失败不终止循环**：未知工具、参数不是合法 JSON、工具抛异常，都以 tool 消息回灌，
  模型还有机会纠正；只有端点级失败才终止。
- **互斥**：`--agent` 不能与 `--semantic`（两者都烧配额，诊断不该混进评分）、
  `--compare`、`--pack-compare`（各有自己的产物）同用。
- **隐私前置**：开启时向 stderr 打印「将把 N 条轨迹的摘要发送至 host」，不受 `--quiet` 抑制。
- **端点实测（2026-10-24）**：支持 function calling；推理型模型的思考**关不掉**
  （`reasoning_effort` / `thinking` / `enable_thinking` 全无效），so 提示词里压思考
  （实测 10.5s → 3.4s）；`max_tokens` 给小了会让 reasoning 吃光额度、`content` 空串。
- **提案（P3）只提不生效**：`propose_pack` 交出「草稿包 + 试跑数字」，**永不自动生效**。
  界面侧「应用到工作区」是唯一的采纳入口，走 `pack/adopt`：**先把当前包存成变体再换包**，
  一步完成（拆成两次 dispatch 会留下「变体存了、包没换」的半截状态）。变体已满时不阻断采纳，
  但 toast 明说「原口径未另存」。采纳前必须把改动摊成「字段 改前 → 改后」——
  只说「改成什么」不够，一键应用等于盲改。
  CLI 把第一份写成 `proposal.pack.json`，它就是一份完整规则包，可直接 `--pack` 复跑；
  多份提案只在 `agent.json` 里。`propose_pack` 与 `simulate_pack` 共用 `draftPack` +
  `simulateOn`，所以「模拟能过、提案过不了」这种自相矛盾在结构上不存在。
- **提案里没有完整包**（`agent.json` 只给 `packName` + `edits` + `applied` + `rows`）：
  完整包只在 `proposal.pack.json` 一处，免得同一份数据两处漂移。
- **定向诊断**：`--agent-task <文本>` 把用户的问题塞进 user 消息；试跑会把两条消息原样打出来，
  所以「定向指令到底传没传」不用猜。

### 本地诊断服务（P2，界面入口）

`qa serve` 把同一套 `runAgent` 挂到本机 HTTP 上，界面「诊断」按钮经它调模型。
密钥留在服务进程里，页面只拿得到结论——这是 ADR-0011 写明的形态，不是临时方案。

```bash
trajectory-qa serve                 # 127.0.0.1:7788
trajectory-qa serve --port 7788 --token abc123
# 界面：在 URL 后加 ?agent=http://127.0.0.1:7788（有 token 再加 &agentToken=abc123）
```

- **只 bind `127.0.0.1`**；`--host` 非回环地址时终端会警告（局域网内其他机器就连得上了）。
- **CORS 白名单**：放行本机 http；`file://`（Origin 为 `null`）**只在设了 `--token` 时**放行。
  `Origin: null` 也来自沙箱 iframe 与 `data:` 页面，分不出来，所以没有 token 时一律拒（预检不给 CORS 头，
  POST 直接 403）。其它来源拿不到 CORS 头，浏览器会拦下读取。
- **Host 校验**：绑在回环地址时，`Host` 不是回环名的请求一律 403 且不带 CORS 头，挡 DNS 重绑定。
  用户显式绑到非回环地址（`--host`）时关闭这道校验，防线是 token 与启动警告。
- **界面 `?agent=` 只认回环地址**（`readAgentTarget`）：链接可以是别人发来的，不限制的话，
  点「诊断」就把整条轨迹发给任意主机。非回环、非 http(s)、解析不了的都当作未配置。
  回环判断在 `src/lib/loopback.ts`，serve 与界面共用一份。
- **token 拦的是另一件事**：跨站页面仍能「盲发」请求消耗额度，所以留了 `--token`；
  不设时终端明说风险（本机自用没关系）。
- 端点：`GET /health`（只答模型名与是否需要 token，**不含密钥与端点路径**）、
  `POST /api/diagnose`（NDJSON 流）。
- **流式用 NDJSON 不用 SSE**：POST 配 `EventSource` 用不了，还得另写一套手动解析。
  事件四种：`start` / `progress`（轮次、工具名、耗时）/ `done`（完整 `AgentRun`）/
  `error`（`code: 'partial'` 表示有会话被跳过，不是整次失败）。
- **界面只在点「诊断」时发请求**，不探测、不预取；没配 `?agent=` 时按钮禁用并给出启动命令。
- 诊断结论不落 reducer、不持久化、不进评分（不变量 7）。
- 请求体只发 `step` 去掉 `raw` 后的形状：`raw` 是解析前的原始对象，常常比整条轨迹还大，
  本机传输也不例外。
- 单条坏会话在服务端被隔离（与 `analyze` 同一条不变量），界面照实显示「有 N 条被跳过」。
- **诊断报告单独成篇**：界面跑完可在面板里导出 `agent.md` / `agent.json`，与评分报告
  （`report.md/json/html`）并列而非混写。理由与不变量 7 同源——模型的话会漂移，
  混进评分报告后，半年后没人分得清哪句是规则说的、哪句是模型说的。
  导出用的是**诊断当时**的会话与规则包快照，不是导出时的最新状态，所以报告能复现那一刻。
- 报告渲染对缺字段容错（`rationale` / `evidence` 缺失只省略那一行）：模型输出不可全信，
  旧存档也可能缺字段，一个字段就让整份报告崩掉，与「单条坏数据不影响其余部分」相悖。
- **导出按钮在抽屉页脚，不在结果区末尾**：诊断结论常有十几屏，按钮埋在最后一屏等于没有
  （第一次真机验收就是这么找不到的）。页脚常驻，且不随滚动消失。
- **重开面板恢复上一次结论**（`restored`）：结论存在控制器里，关掉面板不该等于丢掉——
  为了看一眼就要重跑一次，烧的是真配额。恢复只在「打开」这一刻做一次，
  否则点「再诊断一次」的瞬间会把旧结论塞回来，看着像秒回。

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
- 与 Markdown / JSON 同源（同一 `ReportInput`），三份数字不会分叉。JSON 里是 `totals`
  （就是 `reportTotals` 的结果）与 `rulePack.enabledRules`；`rulePack.rules` 仍是规则总数
  （含停用的），键名是给 CI 的契约，含义不改。
- 汇总数字只算一次：`reportTotals(entries, pack)`（会话数/步数/token/均分/启用规则数），
  三份产物共用；对比的 diff 也只算一次：`buildComparisonModel`（内含 LCS 对齐，跑两遍纯属浪费）。
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
改包重跑规则实测：10k 步约 10ms、50×1k 步约 44ms（解析同规模需 39ms）——远低于交互阈值，
故评分留在主线程、按 `(sessions, pack, annotations)` 记忆化即可，不必挪进 worker。
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
`verify` 依次是：typecheck → lint → 覆盖率测试 → 文案扫描（`src/ui` + `src/cli` + `src/app` + `src/lib`，
汉字与全角标点都算；导出报告里写死的 `：` `（` 会让英文报告混进全角符号）→ 单文件构建 →
产物契约校验 → CLI 构建 → CLI 冒烟（`scripts/smoke-cli.mjs`）。
产物契约校验（`scripts/check-artifact.mjs`）要求：不得含外部脚本/样式/远程图片，
必须有 `#root`，体积不超过 1500 KB（`ARTIFACT_BUDGET_KB` 可调）。
产物与覆盖率作为 artifact 上传（保留 14 / 7 天）。本地等价入口：`pnpm verify`。

## 输入格式

**支持**：OpenAI Chat Completions 消息数组、`{messages:[…]}` 等常见容器（`messages / steps / trajectory /
conversation / history / transcript / turns / items / events / log`，可嵌在 `data / result / payload /
session / record / thread / run` 下）、JSONL（每行一条消息或一个会话）、OpenAI Responses 条目
（`function_call` 以 `call_id` 配对，`function_call_output`）、Anthropic 内容块（`tool_use` / `tool_result`）。

- 一条消息里有多个 `tool_result`（Anthropic 的并行工具调用）会**拆成多个步骤**，每个结果单独配对。
  所以步号对应的是拆分后的步骤，不一定等于原始消息序号。
- **没有任何 assistant 或 tool 步骤的会话不评分**，记入 `issues`（原因 `NOTHING_TO_SCORE`）。
  规则是「找毛病」，空轨迹毛病为零，会得 A；角色全是 `unknown` 的异形格式同理。
  文件里所有会话都如此则整个文件失败（CLI 退出码 2）。

**也支持**（这几种曾被悄悄读错、照样给高分，现在读对了）：
- **ShareGPT**：`{conversations:[{from:'human'|'gpt'|'system', value}]}`，或直接一串 `{from, value}`。
- **LangChain**：`model_dump()` 的 `{type:'human'|'ai'|'tool'|'system', content}`（角色在 `type` 里，
  只在没有显式 `role` 时才用）、`messages_to_dict()` 的 `{type, data:{…}}`、以及构造器形式
  `{lc, type:'constructor', id:[…,'HumanMessage'], kwargs}`（角色来自类名）。剥壳只在确认是这两种壳时才做，
  普通消息恰好带个 `data` 字段不会被误剥；`Step.raw` 仍是剥之前的原对象。
- **SWE-agent** 记录同时有 `trajectory`（动作记录）和 `history`（消息）：取里面**真是消息**的那个数组，
  不再按键的先后取第一个。

**不支持**（会被拒绝，不是打分）：OpenHands 事件（`source` / `action` / `observation`）、
ShareGPT 工具调用变体（`function_call` / `observation` 角色）、其它自定义日志。这类输入没有
assistant 或 tool 步骤，走上面的「无可评分」，CLI 退出码 2。如果它们恰好带了能被读成
assistant/tool 的字段，仍可能被读错——遇到请先转成上面的形态。

## 已知边界

- **`src/core` 的报错文案不本地化**（解析说明、规则标题同属数据/逻辑，故 `check-i18n` 不扫 core）。
  界面与 CLI 一律以 `t('error.<code>')` 覆盖它：core 的 `message` 只是没有字典时的兜底。
  `IngestIssueCode` 因此**直接复用 `ErrorCode`**，错误码一路带到 UI 不被压平——把一切折叠成
  `analysis-failed` 会让「不是合法的 JSON」和「结构无法识别」显示成同一句话。
- **语义复核的 `SemanticIssue.message` 是运行时诊断原文**（网络/API 错误，内容不可控），不做本地化；
  它前面的 `✗ 文件 ·` 计数行走字典。
