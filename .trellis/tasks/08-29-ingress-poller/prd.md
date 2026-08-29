# 接入自动化 Poller

父任务：`.trellis/tasks/08-29-phase2-entry`。

## Goal

当「Issue 到达但没人跑 CLI」成为真实痛点时，提供 **daemon 进程**定时扫描带 `keel` label 的 open Issue 并执行 `ingest-issue` + `run-issue`。

## Background

`08-27-github-issue-automation` Phase 3 立项，Webhook 推迟。roadmap：先 poller 再 webhook。

## Trigger（本任务 start 条件）

满足任一：

- 人工执行 `keel run-issue` ≥3 次/天，持续 3 天
- 或用户明确要求提前做

**当前：未触发，保持 planning。**

## Requirements（触发后）

- R1 `keel poller` 子命令：间隔 `--interval`、单 repo、`--label keel`
- R2 幂等：已 ingest 的 Issue 不重复 run（查 task_feedback）
- R3 单进程、无 HTTP；日志结构化
- R4 文档：部署方式、凭据、与 timer-worker 关系

## Acceptance Criteria

- [ ] AC1：poller 跑 1h，新 Issue 自动到 S-DONE 或如实停 S-HUMAN_REVIEW
- [ ] AC2：重复 tick 不产生 duplicate task
- [ ] AC3：`pnpm run check` 全绿

## Out of Scope

- Webhook / 签名校验
- 多 repo 路由
- Work queue 并发

## Dependency

五连 + 第二 Harness 非硬依赖；建议在阶段二入口闭合后。
