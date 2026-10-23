# Trajectory QA Console

**智能体轨迹数据的四维质检台**：拖入 Agent 轨迹（OpenAI messages / tool_calls 格式），本地完成解析、评分与问题定位——零后端、零上传、双击即用。

A single-file, offline QA console for agent trajectory data. Drop a trace, get a four-axis checkup.

## 它解决什么问题

Agent 上线前后的轨迹（system / user / assistant / tool 结果交错）常藏着结构缺陷与执行病灶：
工具调用没有配对结果、参数是非法 JSON、连续 9 次重复调用、失败率超三成……
人工翻日志既慢又容易漏。本工具把这类**可规则判定**的问题自动化，逐条定位到具体步骤并给出可执行建议。

## 功能

- **四维评分**：结构合法性 / 执行健康度 / 效率与成本 / 语义质量；严重问题触发等级封顶，不让一条致命缺陷被加权平均稀释。
- **沙箱规则 DSL**：24 条内置规则都是数据（`scope + expr`），表达式经编译期校验 + 白名单解释器求值（无 `eval`）；字段契约带最近匹配建议。中英双语规则包（`packs/builtin-en.json`）。
- **试跑与调参**：在抽屉里改阈值，命中数与「禁用后能涨几分」即时重算；满意后存成**命名变体**，一键切回。
- **轨迹对比**：按结构（角色 + 工具序列）LCS 对齐、按内容指纹判变——改 prompt 后「同一回合换了说法」显示为内容变化，而非全删全增。
- **报告三形态**：Markdown（贴 PR / 周报）、JSON（键名稳定，给 CI）、单文件 HTML（双击即看、零脚本、可打印为 PDF）。
- **双语界面**：中文 / EN 一键切换，`<html lang>` 同步、持久化；报告跟随界面语言。
- **命令行**：整目录批量、`--fail-below` 质量门禁、`--semantic` 可选 LLM 语义复核（密钥只从环境变量读取、失败自动降级）。产物为自包含单文件，拷到任何 Node 22 机器即可运行。

## 快速开始

```bash
pnpm install
pnpm dev              # 开发
pnpm build            # 产出 dist/index.html（单文件）+ dist-cli/qa.mjs（CLI）
pnpm verify           # typecheck + lint + coverage + 文案扫描 + 构建 + 产物契约 + CLI 冒烟
```

界面：打开 `dist/index.html`，拖入轨迹文件（`.json` / `.jsonl`），或点「示例轨迹」。
调试深链：`#demo:N` 载入示例、`#stress:N` 生成 N 步合成轨迹、`?drawer=1` / `?diag=1` / `?compare`。

命令行：

```bash
node dist-cli/qa.mjs examples                          # 列表 + 结论
node dist-cli/qa.mjs traces --fail-below 80            # 门禁（不通过退出码 1）
node dist-cli/qa.mjs a.json b.json --compare --out cmp # 对比报告
node dist-cli/qa.mjs traces --format html --out out    # HTML 报告
node dist-cli/qa.mjs traces --semantic-dry-run         # 语义复核：只看提示词，不调用模型
```

语义复核需环境变量：`TQA_LLM_URL`、`TQA_LLM_MODEL`、`TQA_LLM_API_KEY`（只从环境读取，不接受命令行参数）。

## 工程

- **311 项测试**，覆盖率 95.6% 行 / 87.2% 分支 / 92.3% 函数；`pnpm verify` 八道关全绿是合并的唯一标准。
- 分层：`core`（解析 / 规则 / 评分 / 对比 / 语义）/ `app`（状态机 / 持久化 / 遥测 / 分析端口）/ `ui` / `lib` / `cli`，接口小而行为厚。
- 行为快照：4 条示例轨迹的分数与问题清单逐字段锁定（golden master）；600+ 例解析 fuzz；性能预算测试（10k 步 < 3s）。
- 领域词汇、不变量与模块地图见 [CONTEXT.md](CONTEXT.md)；17 份 ADR 记录关键取舍（[docs/adr](docs/adr)）。

## License

[MIT](LICENSE)
