# ADR-0019 智能体诊断：模型只解释分数，不参与打分

- 状态：已采纳
- 日期：2026-10-24

## 背景

语义复核（ADR-0011）补上了「答非所问 / 无依据断言」这类**语义**判断，但它回答的是
「这条轨迹有没有语义问题」，不回答人真正要问的两个问题：

- 这条会话**为什么**只有 54 分？（规则只说「命中 X」，不说因果链）
- 一批轨迹的**共性**是什么，该改哪条规则，改完会怎样？

这两个问题都需要**多步取数 + 归因**，正好是工具调用的形状。而项目已有的能力
（`buildCard` / `runRules` / `scoreUnderPack` / `tuning` / `compare`）全是确定性的纯函数，
把它们包成工具交给模型编排，不会引入任何新的算法路径。

## 决定

1. **命令行直连，界面经本地服务。** CLI `--agent` 直接调模型；界面不持密钥，
   而是经 `qa serve`（127.0.0.1）间接调用——这正是 ADR-0011 写明的「本地小服务 + 浏览器调本机」。
   两条路走同一个 `runAgent`，所以结论不会因为入口不同而分叉。
2. **模型只能调用既有纯函数，数字只能来自工具。** 12 个工具全部映射到已有实现，
   新增代码只有参数校验与结果裁剪。`report.ts` 只渲染工具返回值；模型的自然语言
   单独成节并**显式标注未核验**。
3. **诊断不参与打分。** 结论进 `agent.md` / `agent.json`，不进 `ScoreCard`、
   不进 `semantic` 维度、不进 `ReportBundle`。invariant 3（分数纯派生、同一输入同一分数）
   不能因为接了模型而破——模型输出的漂移只影响解释，不影响分数。
4. **传输层复用而非另起。** `LlmTransport` 从 `core/semantic` 抽到 `core/llm`，
   超时/重试/响应解析各只有一份。语义复核与智能体是同一端点、同一密钥、同一套脱敏纪律。
5. **预算硬上限 + 未收敛如实标注。** 轮次 8 / 工具调用 24 / 墙钟 180s / 单次 90s / 输出 4096 token。
   撞上限就停，`trace.truncated = true`，报告写「未收敛」并说明是哪个上限。
6. **失败也保留 trace。** `AgentRun` 不用 `Result` 包装：「为什么没得出结论」恰恰要靠 trace 回答，
   折成 `{ ok: false }` 等于把唯一证据丢掉。
7. **显式开启 + 隐私前置。** 默认关闭；开启时向 stderr 打印「将把 N 条轨迹的摘要发送至 host」，
   不受 `--quiet` 抑制。与 `--semantic` / `--compare` / `--pack-compare` 互斥
   （两个都烧配额，且诊断结论不该混进评分）。
8. **终结工具而非自由文本。** `submit_diagnosis` 显式收尾并结构化结论；
   模型若直接给文本也算收尾（`answered`），但报告会区分这两种结束方式。

## 取舍

- **为什么不用官方 `openai` SDK。** 三条具体理由：① CLI 是单文件 bundle，SDK 会把它的重试、
  超时、错误包装一并打包，与 `core/llm/complete` 已有的策略叠加，「谁在重试」变成谜；
  ② `LlmTransport` 是可注入纯函数，假模型能覆盖循环/预算/取消全路径，换成 SDK 就得 mock 它；
  ③ 现有测试断言「错误信息绝不回显密钥」，多一层包装就多一处要审。
  SDK 的请求/响应形状仍是事实标准，所以 wire 类型照抄（`tool_calls` / `finish_reason` / `role: tool`）。
- **为什么 token 默认关闭**。默认只在 `127.0.0.1` 上监听、CORS 只放行 file:// 与本机 http，
  正常路径已经挡住「别的网站读走结果」。剩下唯一的风险是跨站**盲发**请求烧额度——
  这个风险本机自用场景极低，强制 token 反而让每次启动都多一步复制粘贴。
  所以做成可选，且不设时终端明说风险；公用机器上一条 `--token` 就够。
- **为什么流式用 NDJSON 而不是 SSE**。`EventSource` 只支持 GET，而诊断要 POST 一坨轨迹；
  要么改成 GET+查询串（体积不允许），要么在 SSE 上手写解析。既然都要手写，NDJSON 更短。
- **为什么不做多轮自检**（让模型复核自己的结论）：成本翻倍、收益不确定，
  与 ADR-0011 对「同一输入同一结论」的判断一致。
- **提案只提不生效。** `propose_pack` 交出的是一份「草稿包 + 试跑数字」，落不落地由人决定：
  CLI 写成 `proposal.pack.json`（可直接 `--pack` 复跑），界面将来走规则抽屉导入。
  它复用 `simulate_pack` 的 `draftPack` + `simulateOn`，因此「模拟说能过、提案却过不了」
  在结构上不可能发生。工具返回里显式带 `appliedToWorkspace: false`，
  是为了让模型别在结论里写「已修复」。
- **`delta = 0` 的提案仍然允许提。** 试过真机：模型三次调 `simulate_pack` 得出 delta 全为 0，
  于是明确说「规则包不必改」——这是正确输出，比硬凑一条提案有价值。
  但反过来也放过：扣分力度是否符合「严重度」并不总和平均分变化等价
  （封顶会把差异吃掉），此时模型给的理由（相对权重）仍有价值。
  工具的职责是算准并把数字交出去，不是替人判断值不值得——与「agent 不参与打分」同一条界限。
- **为什么报告分「结论」与「调用记录」两节。** 模型可以编数字，工具不会。
  分成两节，读者一眼能看出哪句是判断、哪个数字是事实——这比事后校验模型文本里的数字现实得多。
- **已知代价**：输入 token 随轮次线性增长（实测 3 条会话、4 轮、6 次工具调用 = 16k token，
  其中 14.5k 是重复发送的历史）；该端点强制思考，单轮 5-6s。都靠预算上限兜住，不做流式。

## 端点实测（2026-10-24，sensenova-6.8-flash-lite）

| 项目 | 结果 | 对设计的影响 |
| --- | --- | --- |
| function calling | ✅ 两轮循环收敛，单轮 877ms | 方案成立的前提 |
| 流式 | ✅ TTFB ~1s | P2 界面可用；本轮不做 |
| 关闭思考 | ❌ `reasoning_effort` / `thinking` / `enable_thinking` / `chat_template_kwargs` 全无效 | 延迟不可控，只能靠预算 |
| 思考开销 | judge 风格提示词 10.5s（reasoning 421 tok）；加「不要展开思考」→ **3.4s**（168 tok） | 提示词里压思考，一句换三倍速度 |
| `max_tokens` 过小 | reasoning 吃光额度 → `content` 空串 + `finish_reason: length` | judge 显式设 4096，并把「被截断」与「模型没说话」分开报 |

## 后果

- 新增 `src/core/llm/`（`transport` / `complete` / `response`）：语义复核同步改用，
  `judge.ts` 里的私有重试循环删除。
- 新增 `src/core/agent/`（`types` / `chat` / `prompt` / `tools` / `loop`）、
  `src/lib/agent-report.ts`。
- `batch.ts` 的 `BatchResult` 增加 `sessions`（智能体要 id 与 metrics，报告层只要 trajectory + card）。
- CLI 新增 `--agent` / `--agent-dry-run` / `--agent-rounds` / `--agent-trace` / `--agent-task`；
  产物 `agent.md` / `agent.json`，与 `report.*` 分开写；有提案时另出 `proposal.pack.json`
  （完整规则包，可直接 `--pack`）。
- 语义复核三处修正：显式 `max_tokens=4096`、超时 20s → 60s、提示词压思考；
  `TQA_LLM_BASE_URL` 可直接写 base（自动补 `/chat/completions`，且只对 `/v1` 这类版本尾巴生效，
  免得把本地代理的 `/api/chat` 拼坏）。
- 新增 `src/cli/serve.ts`（本地服务）、`src/app/agent-client.ts`（界面唯一网络出口）、
  `src/ui/AgentPanel.tsx`（诊断抽屉）、`src/styles/components/agent.css`；
  `core/agent` 加 `onEvent` 进度回调（回调抛错一律吞掉，客户端关页面不该弄死诊断）。
- 测试：智能体 39 项（全部用假模型，不联网）、报告 11 项、语义 +4 项、CLI +15 项、
  服务 12 项、界面 4 项、接口 9 项；总数 376 → 470。其中一条是**端到端**的：
  CLI 写出的 `proposal.pack.json` 必须能被 `loadPack` 接受并复跑——静态检查不等于
  「能当 --pack 用」。服务侧另有一条：坏规则包必须 400，而不是静默换成内置包
  （那样诊断口径会和屏幕上的分数不一致）。
- 界面零改动——与 ADR-0011 一样，这是刻意的边界。
