# CONTEXT — 轨迹质检台

单文件 Agent 轨迹质检工具。所有解析、质检与评分在浏览器内完成，文件不出本机。

## 领域词汇

| 术语 | 含义 |
| --- | --- |
| **轨迹（Trajectory）** | 一次 Agent 运行的完整消息序列，含 meta（模型、起止时间、token）。 |
| **步（Step）** | 轨迹中的一条消息，已归一为 `role / text / reasoning / toolCalls / result`。 |
| **工具调用（ToolCall）** | 助手发起的调用；`argsValid` 为 false 表示参数不是合法 JSON。 |
| **工具结果（ToolResult）** | 由 tool 消息承载的返回值；`isError` 来自显式标记或 `Error:` 前缀。 |
| **配对（Pairing）** | 用 call id 把结果挂回调用；没有 id 时才按函数名兜底，悬空 id 只报告不猜。 |
| **发现（Finding）** | 一次规则命中：规则 id、维度、严重度、步号、证据、扣分。 |
| **维度（Dimension）** | 质检口径，带权重与颜色；默认四维：结构 / 执行 / 效率 / 语义。 |
| **规则（Rule）** | 数据：`scope + expr + message`，不含代码。 |
| **规则包（RulePack）** | 维度 + 规则 + 版本，可在界面内编辑、导入导出。 |
| **评分卡（ScoreCard）** | 派生结果：维度分、加权分、封顶分、等级、问题计数。 |
| **错误封顶（Error gate）** | 按「不同 error 级规则数」限制总分：≥1→74、≥3→54、≥5→39。 |
| **会话分析（SessionAnalysis）** | 一条轨迹的质检产物：指标、发现、规则异常、耗时诊断。 |
| **工作区（Workspace）** | 会话集合 + 选中态 + 规则包 + 人工标注 + 导入问题。 |
| **分析端口（Analyzer port）** | `analyze(request, signal)`；同步 adapter 与 worker adapter 两个实现。 |

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

## 质量门槛

`pnpm verify` = typecheck + lint + 覆盖率测试 + 构建。覆盖率门槛：行/函数/语句 ≥85%，分支 ≥75%。
四条示例轨迹的分数与问题清单由 `src/core/__golden__/samples.json` 锁定。
样式分四层（tokens / base / layout / components），只允许上层引用下层变量，不靠权重压制。
交互元素均可键盘到达；抽屉有焦点陷阱与 Esc 关闭；动效尊重 `prefers-reduced-motion`。
性能基线：1k 步 < 500ms、10k 步 < 3s（实测约 20ms / 98ms）。
