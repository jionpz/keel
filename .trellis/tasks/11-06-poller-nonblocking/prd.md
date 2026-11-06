# poller 不再被单个慢任务阻塞

> 对应 GitHub issue [#74](https://github.com/jionpz/keel/issues/74) 第 2 条。
> 技术设计见 `design.md`，执行计划见 `implement.md`。

## Goal

把 poller 的**扫描节奏**与**单任务驱动时长**解耦：
一个顶满墙钟的 `develop` 不再让同轮其余 issue、以及后续轮次的新 issue 一起等待。

## Background

`pollOnce` 对每个非终态 issue 顺序 `await deps.runIssue(...)`，而 `runIssue` 内部的
`runTaskToCompletion` 要到任务终结或暂停才返回（[poller.ts:189](../../../src/ingress/poller.ts)）。
一个 30 分钟的 develop 会把同轮其余所有仓库的 issue 一起堵住，下一轮扫描也要等它结束，
轮询间隔名存实亡。

## Requirements

- **R1 扫描与驱动解耦**：一轮只负责扫描与**调度**，不等待驱动完成；下一次扫描按 interval 照常进行。
- **R2 有界并发**：同时驱动数不超过 `N`（缺省 3，与全局 `DEFAULT_MAX_RUNNING_RUNS` 对齐）。
  本轮排不下的 issue 记为 `deferred`，不排队、不丢弃，下一轮重新扫描时再试。
- **R3 不双跑**：同一 `external_ref` 在驱动未结束时（含跨轮）不会被再次驱动；
  同一轮内重复 repo 行的既有去重规则保持不变。
- **R4 信号语义**：SIGTERM / SIGINT 后不再调度新 issue；**所有在途驱动**结束后退出；
  仍不强杀进行中的 run。
- **R5 失败隔离**：单个 issue 驱动失败只记 `issue_error`（detail 脱敏），不影响其它在途驱动与后续轮次。
- **R6 不可预期异常不吞**：`runIssue` 抛出编程错误 / 基础设施故障时，先停止调度并等在途驱动收尾，
  再把异常抛出进程（与改前「照常抛出」一致）。
- **R7 一次性语义保留**：`pollOnce` 仍按原样同步驱动并返回聚合结果，供测试与一次性调用使用；
  其行为与日志字段不变。
- **R8 CLI**：`keel poller` 新增 `--concurrency <n>`；缺省取全局上限；非法值（0 / 负数 / 小数 /
  非数字 / 只写标志 / 超过全局上限）明确拒绝，不静默回退。
- **R9 日志**：轮询行新增 `scheduled / deferred / inFlight`；驱动成功新增 `issue_driven` 行（含 `created`）。
  detail 继续脱敏，不打印 issue body。

## Acceptance Criteria

- [ ] 模拟某 issue 的驱动永不返回时，后续轮次仍能扫描并把其它 issue 调度起来（测试覆盖）。
- [ ] 并发上限生效：`N+1` 个可驱动 issue 时，同时在跑的驱动最多 `N` 个，其余记为 `deferred`。
- [ ] 同一 `external_ref` 不会并发双跑（跨轮测试覆盖）。
- [ ] SIGTERM 后不再调度新 issue；在途驱动全部结束后进程才退出。
- [ ] 驱动失败隔离且日志脱敏；不可预期异常仍以抛出结束，不被静默吞掉。
- [ ] `--concurrency` 的非法值与超上限均被拒绝，错误文案可执行。
- [ ] `pnpm run check` 全绿；既有 poller 测试不回归。
- [ ] `README.md` 与 `.trellis/spec/backend/ingress-poller.md` 的行为/日志契约同步更新。

## Constraints

- 单进程、单实例（现有 advisory lock 不变）；不引入队列 / 并发框架或新依赖。
- `src/ingress` 不依赖 `src/control`：并发缺省值在 CLI 接线层解析后传入。
- 不改 `runTask` / orchestrator / claim 逻辑；N3/N4 数据库守卫仍是唯一的并发事实来源。
- 不实现硬取消；在途 run 仍只在当前 stop point 返回。

## Out of Scope

- 持久化工作队列、跨进程调度、任务优先级。
- 进行中 run 的硬取消。
- 阶段级墙钟与重试次数（issue #74 第 3 条）。
- 运行时动态调整并发数。

## Key Decisions

- **调度而非排队**：本轮排不下的 issue 记为 `deferred` 并在下一轮重扫，不引入内存队列。
  理由：poller 的幂等来源是「每轮重新扫描 + feedback 唯一键」，队列会变成第二份待办状态，
  与 Fact Plane 的事实来源冲突。
- **缺省并发 = 3**：与 `DEFAULT_MAX_RUNNING_RUNS` 一致；超过全局上限的并发只会产生可重试
  `CONFLICT` 噪音，因此 CLI 直接拒绝。
- **保留 `pollOnce`**：一次性同步语义仍有用（测试、脚本、诊断），且能让既有测试继续覆盖
  扫描与去重逻辑；常驻路径改走 `scanOnce` + 调度器。
