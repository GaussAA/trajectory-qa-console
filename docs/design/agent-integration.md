# 智能体集成方案（提案稿，已实施）

> 状态：**已实施**，决策已固化为 `docs/adr/0019-agent-diagnosis.md`。
> 本文件保留当时的分析与取舍过程，供回溯「为什么这么设计」。
> 日期：2026-10-24 ｜ 端点实测：2026-10-24（sensenova-6.8-flash-lite）

## 一、结论先行

三句话：

1. **做** —— 但只做「工具化诊断 agent」：模型多轮调用**本项目的纯函数**，产出「根因链 + 整改动作」，
   **不进评分**。
2. **不做** —— 界面直连模型、agent 参与打分、agent 自动改轨迹。
3. **落点** —— 仍走 CLI（`--agent`），延续 ADR-0011 的三条线；界面若要，P2 用「本地小服务 + 127.0.0.1」。

理由：这个项目已有的四类能力（规则、语义判定、调参试跑、口径对比）**全是确定性的**，
agent 的价值不在替它们算，而在**把它们串成一条推理链**——「哪条最差 → 为什么差 → 改哪条规则 →
改完会怎样」。串链需要工具调用，而这个端点恰好支持。

## 二、「智能体」的三种解读，先分清

| 层次 | 形态 | 在本项目的对应 | 判断 |
| --- | --- | --- | --- |
| L1 单轮判定 | 一次 prompt → 一次 JSON | 已有 `semantic/judge.ts` | 已具备，只需适配端点 |
| **L2 工具诊断** | 模型 + 只读/纯计算工具 + 多轮循环 | **本文主张** | 收益最大、风险可控 |
| L3 闭环修复 | 能改规则包、改轨迹、提交门禁 | 无 | 只开放「提案 + 契约校验」的窄口 |

L2 的具体产出物（不是聊天框）：

> 「12 条轨迹平均 68.4，短板在 `exec` 维（均值 41）。共性原因：7 条在工具返回 `Error:` 后
> 没有重试而是直接道歉收尾（命中 `recoverable-error-unhandled` 9 次）。建议把
> `exec.retry_missing` 的 `scoreImpact` 从 4 提到 6——试跑后均值 68.4 → 63.1，
> 排序不变但红线更敏感。」

每句话都能追到一次工具调用，这才是可用的诊断，而不是"请注意优化提示词"。

## 三、端点实测（硬事实，决定了设计）

| 项目 | 结果 | 影响 |
| --- | --- | --- |
| `/v1` 可达、OpenAI 兼容 | ✅ 200 / 1500ms | 现有 `fetchTransport` 直接可用 |
| `/models` | 7 个模型，本模型 262k 上下文、多模态、`supported_features: tools, json_mode, reasoning` | 够用 |
| **function calling** | ✅ 两轮循环收敛成功（tool_calls → 回填 → 自然语言结论），单轮 877ms | **agent 方案成立的前提** |
| 流式 | ✅ TTFB ~1s | P2 界面可做逐字输出 |
| **强制思考** | ⚠️ `reasoning_effort=none` / `thinking.type=disabled` / `enable_thinking=false` / `chat_template_kwargs` **四种关法全部无效**，`message.reasoning` 恒有值 | 延迟与 token 不可完全控 |
| 思考开销（judge 风格 prompt） | 默认 → 10.5s / reasoning 421 tok；<br>system 加「禁止展开思考」→ **3.4s / reasoning 168 tok** | **一句提示词换 3 倍速度**，性价比最高 |
| 不传 `max_tokens` | 正常（completion 283） | 短轨迹无碍；长轨迹有风险，见下 |

**两个真实会踩的坑**（沿用现有 `judge.ts` 就会中）：

- `judge.ts` 的请求体里**没有 `max_tokens`**。实测 `max_tokens=64/512` 时 reasoning 会把额度吃光，
  `content` 返回空串、`finish_reason: length` → 现有代码走到「模型响应里没有可用内容」，
  **看起来像模型坏了，实际是没给够预算**。
- 现有超时是 **20s**。judge 风格短轨迹已要 10.5s；120 步摘要（默认抽样上限）只会更久 → **必然超时**。

## 四、落点：三个候选

| 方案 | 密钥在哪 | CORS | 单文件离线契约 | 工作量 | 判断 |
| --- | --- | --- | --- | --- | --- |
| **A. CLI `--agent`** | 环境变量 | 无（Node 直连） | 不受影响 | 小 | ✅ **P0 推荐** |
| B. `qa serve` + 界面按钮 | 本地服务进程 | 无 | 不受影响（界面仍零外链） | 中 | P2，ADR-0011 明写的"正确形态" |
| C. 界面直连 | 页面 / localStorage | 多数供应商禁 | **破坏**，且 `check-artifact` 零外链契约失守 | 最小 | ❌ 否决 |

C 的具体死因不是洁癖：`scripts/check-artifact.mjs` 断言产物「不得含外部脚本/样式/远程图片、
必须有 `#root`、≤1500KB」。密钥进页面 = 任何拿到这个 HTML 的人都能读；CORS 还要供应商点头。
ADR-0011 已把这条钉死，本轮不改它。

## 五、架构：新模块 `src/core/agent/`

```
src/core/agent/
  types.ts    AgentMessage / ToolSpec / ToolCallRequest / AgentStep / AgentTrace / AgentOutcome
  prompt.ts   系统提示（工具纪律 + 输出契约）
  tools/      工具注册表：name → { spec, run(args, ctx) }（inspect / pack / diagnosis 三组，index.ts 汇总）
  loop.ts     循环：模型 → tool_calls → 执行 → 回填 → 终止条件
  budget.ts   预算闸：轮次 / 工具调用数 / 墙钟 / token / 单工具超时
  report.ts   把 trace 收敛成结构化诊断（Markdown / JSON）
src/cli/agent.ts   `--agent` 等参数与终端呈现（IO 胶水）
```

**传输层复用而非另起。** 现有 `core/semantic/types.ts` 的 `LlmTransport` 只回
`{ok, status, text}`，judge 也只读 `content`。agent 需要 `tool_calls` 与多轮历史。
做法：**扩展同一份传输层**（加 `parseChatResponse` 解析 `tool_calls` / `reasoning` / `finish_reason`），
不新造第二套 fetch。

理由是本项目已经为「同一件事算两遍」付过三次代价（MD/JSON/HTML 各算一遍对比 diff）。
传输层分叉会重演：两处超时、两处重试、两处脱敏，迟早只有一处被改。

**数据流**（单向，无回写）：

```
CLI: 文件 → collect → analyze → sessions+metrics
                                 ↓
                        AgentContext { sessions, pack, annotations }
                                 ↓
   loop: messages → LLM → tool_calls → tools.run(ctx) → tool 消息 → LLM → …
                                 ↓
                    submit_diagnosis → AgentTrace + Report
                                 ↓
                  落盘 agent.md / agent.json（不碰 report.md）
```

## 六、工具集：全部映射到既有纯函数，零新算法

| 工具 | 复用 | 读/写 |
| --- | --- | --- |
| `list_sessions` | `scoreSession`（分数/等级/步数/token） | 只读 |
| `get_card` | `buildCard`（维度分、封顶、计数） | 只读 |
| `get_findings` | `card.findings`（可按维度/严重度过滤） | 只读 |
| `read_steps` | `semantic/prompt.ts` 的 `renderStep` + `pickSteps` | 只读 |
| `get_step` | `trajectory.steps[i]`（截断并标注 `truncated`） | 只读 |
| `search_steps` | 新增 ~30 行（子串匹配，返回步号+片段） | 只读 |
| `list_rules` | `pack.rules`（id / dimension / severity / expr） | 只读 |
| `simulate_pack` | `runRules` / `scoreUnderPack` | 纯计算 |
| `tune_literal` | `rules/tuning.ts` 的 `numericLiterals` + `replaceLiteral`（**含"替换后必须仍能编译"校验**） | 纯计算 |
| `compare_sessions` | `compareCards` + `diffFindings` | 只读 |
| `submit_diagnosis` | — （终结工具，产出结构化结论） | 终结 |
| `propose_pack` | `validatePack` 闸门 | **唯一写口，且只写提案** |

`propose_pack` 是唯一有副作用倾向的工具，处理方式与规则抽屉一致：
**产出的是候选包，落盘/应用仍须经 `validatePack` 与人手确认**，agent 无权直接生效。

## 七、三条硬纪律（写进系统提示 + 用代码兜住）

1. **数字只能来自工具。** 报告里任何分数、涨幅、命中数必须能在 trace 里找到对应调用；
   模型不得自行加减。→ `report.ts` 只渲染工具返回值，不渲染模型自由文本里的数字。
2. **agent 不参与打分。** 它的结论是**解释**分数，不是构成分数。产物进 `agent.md/json`，
   不进 `ScoreCard`、不进语义维度、不进 `ReportBundle`。
   否则 invariant 3（分数纯派生、同一输入同一分数）会被 LLM 漂移打破。
3. **显式开启 + 失败降级。** 默认关闭；开启前打印「将把 N 条轨迹摘要发送至 `host`」；
   单次调用失败只记 issue，退出码不变（与 `--semantic` 同一条约定）。

## 八、可测性（覆盖率门槛 85% 是硬线）

| 测试 | 手法 |
| --- | --- |
| 循环收敛 | 脚本化假模型：预设 `tool_calls` 序列 → 断言 trace 步数与最终结论 |
| 预算耗尽 | 假模型永远要工具 → 断言在 `maxToolCalls` 处停下并如实报告「未收敛」 |
| 工具报错 | 工具抛错 → 断言错误作为 tool 消息回灌、循环继续 |
| 坏 JSON | 模型返回非 JSON → 断言降级路径 |
| 取消 | `AbortSignal` → 断言在途请求被中止、不吞异常 |
| 回放 | `__golden__/agent-trace.json` 锁一份完整 trace，防循环行为漂移 |

**不需要真调 API 就能测完整条路径**——这是复用 `LlmTransport` 注入换来的最大好处。
真调 API 的部分留给一条 `smoke` 用例（默认跳过，需 env）。

## 九、顺手要修的三处（独立于 agent，P0）

1. `semantic/judge.ts` 请求体显式设 `max_tokens`（建议 4096），并在
   `finish_reason === 'length' && content 为空` 时**报明确错误**，别含糊成「响应里没有可用内容」。
2. 超时 20s → 60s 且可配（`--llm-timeout`）。实测 judge 风格已 10.5s。
3. `SYSTEM_PROMPT` 末尾加「不要展开思考，直接给 JSON」。实测 10.5s → 3.4s，判定质量不降。

另：`resolveSemantic` 只认全 URL（`TQA_LLM_URL`）。建议兼容 `TQA_LLM_BASE_URL`（自动拼
`/chat/completions`），降低配置门槛——本次端点给的就是 base 形态。

## 十、分期

| 期 | 内容 | 界面 | 验证 |
| --- | --- | --- | --- |
| **P0** | 端点接入 + 上述三处修正 + 文档 | 零改动 | `pnpm verify` 全绿 + 一条真调 smoke |
| **P1** | `core/agent`（tools/loop/budget/trace）+ CLI `--agent` / `--agent-dry-run` / `--trace` | 零改动 | 假模型全覆盖 + 黄金 trace |
| **P2** | `qa serve`（127.0.0.1，仅本机）+ 界面「诊断」按钮 | 按钮 + 面板 | 界面仍不持密钥、产物仍零外链 |
| **P3** | `propose_pack` → 抽屉「采纳提案」 | 抽屉 | 契约校验拦得住坏包 |

P1 的关键验收不是「能跑」，而是**离线可测**：不联网也能回归整条循环。

## 十一、风险

| 风险 | 缓解 |
| --- | --- |
| 强制思考 → 延迟/成本不可控 | 压思考指令；`--agent-budget` 轮次与调用数硬上限；日志记 token |
| 数值幻觉 | 纪律 1 + `report.ts` 只渲染工具值 + trace 可审计 |
| 免费端点限流（429） | 沿用现有「429/5xx 才重试」策略；失败只记 issue，不动门禁 |
| **隐私**：轨迹摘要离开本机 | 默认关闭；开启前明确打印目标 host 与条数；README 与 `--help` 显著标注 |
| 与 semantic 双份 LLM 调用 | 二者互斥（`--agent` 不自动开 `--semantic`），提示语说明 |

## 十二、待裁

1. **形态**：只做 CLI（P0+P1），还是连着做 P2 的界面按钮？
2. **职责**：agent 只诊断，还是允许它 `propose_pack`（提案规则包，人工采纳）？

默认建议：**P0 + P1 先行，P3 的提案能力保留但在 P1 里只开"读"**（先让它学会看，再让它提议）。
