# 接入自动化 Poller（常驻）

> 对应 GitHub issue [#70](https://github.com/jionpz/keel/issues/70) §2，父任务
> `11-03-enterprise-deployment`。依赖 GHES host 支持与 git 传输认证。
> 本任务目录沿用 2026-08-29 的规划（`08-29-ingress-poller`），需求按新 issue 更新。

## Goal

提供 `keel poller` 常驻子命令：周期扫描所有已注册 github repo 的带 label open issue，
自动 ingest 并驱动到终态，让生产环境无需人工反复执行 `keel run-issue`。

## Background

旧规划（2026-08-29）把触发条件定为「人工跑 `run-issue` ≥3 次/天」。企业内生产要 7×24
无人值守，该条件直接成立。旧 PRD 的「单 repo」范围也扩展为「全部已注册 github repo」。

## Requirements

- **R1 子命令**：`keel poller [--interval <ms>] [--label <name>] [--ci passed|failed|real]
  [--model <id>] [--harness omp|claude] [--wall-clock <秒>]`。
  缺省 `--interval 60000`、`--label keel`、`--ci real`。
- **R2 扫描范围**：每轮查 `repo WHERE provider = 'github'`，逐个 repo 拉
  open + label 的 issue。
- **R3 驱动**：新 issue → `runIssue`（内部完成 ingest + 驱动）；已有 task 且非终态 →
  继续驱动；终态 task → 跳过。
- **R4 幂等**：同一 issue 不重复产生 task（复用 `feedback(source, external_ref)` 唯一键
  与 `driver.intake` 的幂等）。重复 tick 不得双跑同一 task。
- **R5 单进程**：顺序处理，不引入队列 / 并发框架；不监听 HTTP。
- **R6 日志**：每轮一行结构化 JSON，字段至少 `scanned / ingested / driven / skipped / errors`；
  token 等敏感值不得出现。
- **R7 优雅退出**：SIGTERM 后不再认领新 issue，当前 run 结束即退出。
- **R8 与 timer-worker 的分工**：poller 管扫描与驱动，timer 管到期收割；
  两者不互相替代，poller 不处理 wall-clock timer。
- **R9 单个 issue 失败不终止整轮**：记录 error 后继续下一个。

## Acceptance Criteria

- [ ] 带 label 的 open issue 在一个 interval 内被拾取并驱动。
- [ ] 已关闭 issue、已终态 task 不重复驱动。
- [ ] 重复 tick 不产生 duplicate task / duplicate run。
- [ ] SIGTERM 后停止认领新工作并退出（当前 run 结束后；见 Constraints）。
- [ ] 单行结构化日志可解析，token 不出现。
- [ ] `pnpm run check` 全绿。

## Constraints

- **AC 调整说明**：issue 原文写「SIGTERM 后 10s 内干净退出」。当前 run 没有外部取消接口，
  强制 10s 退出要么杀进程留下 RUNNING run，要么改编排器契约。本任务采用
  「不再认领新工作 + 当前 run 结束退出」，并如实记录该偏离；硬取消留给后续任务。
- 不新增数据库迁移（去重复用既有唯一键）。
- 不在 poller 内重写 ingest / 驱动逻辑，只组合 `runIssue`。

## Out of Scope

- Webhook 与签名校验。
- 多进程 poller / 分布式锁。
- 自动关闭 issue、自动改 label。
