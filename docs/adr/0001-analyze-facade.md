# ADR-0001：用 analyze() 作为唯一分析门面

- 状态：已采纳
- 日期：2026-10-22

## 背景

重构前，界面依次调用 `parseTrajectory → computeMetrics → runRules → scoreTrajectory`，四条接缝暴露给 UI，调用顺序、错误语义与默认值都由渲染层记住。测试只能逐个模块测「想象的用法」，解析失败还会以异常形式冲到渲染层。

## 决策

引入 `src/core/analysis/index.ts` 的 `analyze(options) → Result<SessionAnalysis[]>`：

- 内部完成解析、指标、规则、耗时统计；
- 失败返回 `Result`，不抛异常；
- 返回每条会话的 `findings`、`metrics`、`ruleIssues` 与 `diagnostics`；
- 评分卡单独由 `scoreSession()` 派生（因为标注会改变分数）。

## 后果

- UI 只需认识 `SessionAnalysis` 与 `ScoreCard` 两个类型；
- 新增输入格式只改 `parsing`，新增规则只改 `rules`，门面不变；
- 门面是测试面：golden master、fuzz、性能计时都打在这一个接口上；
- 代价是 `SessionAnalysis` 成为跨层数据结构，字段变更需同步契约与文档（已在 `CONTEXT.md` 记录）。
