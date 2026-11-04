# 接入自动化 Poller（常驻）

> 对应 GitHub issue [#70](https://github.com/jionpz/keel/issues/70) §2，父任务
> `11-03-enterprise-deployment`。依赖 GHES host 支持（§1）与 git 传输认证（§3）；
> 实施顺序固定为 **GHES → git-auth → poller**。
> 本任务目录沿用 2026-08-29 的规划（`08-29-ingress-poller`），需求按新 issue 更新。
> **2026-11-03 修订**：label 改为按仓库配置；补充分页；依赖顺序显式化。

## Goal

提供 `keel poller` 常驻子命令：周期扫描所有已注册 github repo 中**按各仓库自己的 label
筛选**的 open issue，自动 ingest 并驱动到终态，让生产环境无需人工反复执行 `keel run-issue`。

## Background

旧规划（2026-08-29）把触发条件定为「人工跑 `run-issue` ≥3 次/天」。企业内生产要 7×24
无人值守，该条件直接成立。旧 PRD 的「单 repo」范围也扩展为「全部已注册 github repo」。

2026-11-03 修订针对 A/B/C 多项目场景：不同项目可能使用不同 label，全局单一 `--label`
无法表达；同时原方案的 100 条单页上限会静默漏 issue。

## Requirements

- **R1 子命令**：`keel poller [--interval <ms>] [--ci passed|failed|real]
  [--model <id>] [--harness omp|claude] [--wall-clock <秒>]`。
  缺省 `--interval 60000`、`--ci real`。**不设全局 `--label`**。
- **R2 仓库级 label**：`repo` 表新增 `issue_label text NOT NULL DEFAULT 'keel'`；
  `keel register-repo <remoteUrl> --issue-label <name>` 配置，缺省 `keel`。
  已注册仓库不传该参数时保留原值。
- **R3 扫描范围**：每轮查 `repo WHERE provider = 'github'`，逐个 repo 用它自己的
  `issue_label` 拉 `state=open` 的 issue。
- **R4 分页**：每页 100，按 `page` 递增直到返回不足 100 条；单仓库单轮最多 10 页
  （1000 条），触顶时记 `truncated: true`，不静默截断。
- **R5 驱动**：新 issue → `runIssue`（内部完成 ingest + 驱动）；已有 task 且非终态 →
  继续驱动；终态 task → 跳过。
- **R6 幂等**：同一 issue 不重复产生 task（复用 `feedback(source, external_ref)` 唯一键
  与 `driver.intake` 的幂等）。重复 tick 不得双跑同一 task。
- **R7 单进程**：顺序处理，不引入队列 / 并发框架；不监听 HTTP。
- **R8 日志**：每轮一行聚合结构化 JSON，字段至少
  `repos / scanned / ingested / driven / skipped / errors / truncated`；
  单仓库失败单独一行；token 等敏感值不得出现。
- **R9 优雅退出**：SIGTERM 后不再认领新 issue，当前 run 结束即退出。
- **R10 与 timer-worker 的分工**：poller 管扫描与驱动，timer 管到期收割；
  两者不互相替代，poller 不处理 wall-clock timer。
- **R11 单个 issue 失败不终止整轮**：记录 error 后继续下一个。

## Acceptance Criteria

- [x] A/B/C 三个仓库配置不同 label 时，各自 label 下的 open issue 都被拾取。
- [x] 仓库 issue 超过 100 条时，第二页及以后被拾取；触顶 1000 条时日志出现
      `truncated: true`。
- [x] 已关闭 issue、已终态 task 不重复驱动。
- [x] 重复 tick 不产生 duplicate task / duplicate run。
- [x] SIGTERM 后停止认领新工作并退出（当前 run 结束后；见 Constraints）。
- [x] 单行结构化日志可解析，token 不出现。
- [x] `pnpm run check` 全绿。

## 验收记录

- 实现提交见 Phase 3.4；`pnpm run check` 全绿（629 passed / 5 skipped）。
- **未覆盖（如实记录）**：
  1. 没有起 stub GitHub + 真库跑完整一轮，也没有手工对真实 GitHub 发 SIGTERM；
     行为由注入式单测与 provider stub server 测试证明。
  2. 硬取消未实现：SIGTERM 只保证不再认领新工作，正在跑的 run 结束后才退出（PRD 已记录的 AC 偏离）。
  3. 复核查出的两个**跨任务**遗留未在本任务修：其它碰库 CLI 子命令退出时仍挂住（`pg` Pool 未关闭）；
     `timer-worker` 的 SIGTERM 忙等。poller 自己已在 `finally` 关闭连接池。

## Constraints

- **AC 调整说明**：issue 原文写「SIGTERM 后 10s 内干净退出」。当前 run 没有外部取消接口，
  强制 10s 退出要么杀进程留下 RUNNING run，要么改编排器契约。本任务采用
  「不再认领新工作 + 当前 run 结束退出」，并如实记录该偏离；硬取消留给后续任务。
- **新增一次数据库迁移**：`repo.issue_label`（可加列，默认回填 `keel`）。
  去重仍复用既有 `feedback` 唯一键，不加新表。
- **实施顺序**：本任务在 `11-03-ghes-host-support`（`parseRemoteUrl` / `request(host, path)`）
  与 `11-03-git-transport-auth`（`redactSecrets`）之后开始；不在本任务内重写这两块。
- 不在 poller 内重写 ingest / 驱动逻辑，只组合 `runIssue`。
- 不对 GitHub API 限流做专门退避：单仓库失败按 R11 记录后继续，下一轮重试。

## Out of Scope

- Webhook 与签名校验（「实时」按轮询延迟定义，缺省 60s）。
- 多进程 poller / 分布式锁。
- 自动关闭 issue、自动改 label。
- 仓库级独立 interval / 并发驱动。
