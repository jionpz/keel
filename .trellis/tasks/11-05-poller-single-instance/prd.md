# 常驻进程单实例约束

> 父任务 `11-05-run-reliability-remaining`，issue #73 第 2 项。
> 中体量任务：开工前需要 `design.md`（锁方案与退出顺序）。

## Goal

同一个 keel 数据库上，同一种常驻角色（poller / timer-worker）只允许一个实例；
崩溃后锁自动失效，不需要手工清理。

## Background

- poller 没有锁：同一台机器可以同时跑两个 poller 扫同一仓库。
- timer-worker 也没有锁：两个 worker 可以同时收割、重复投递 `RunStalled`。
- liveness 任务只声明「单编排进程 + 独立巡检进程」是前提，没有强制。
- 当前没有租约 / pidfile / advisory lock 任何一种机制。

## Requirements

- **R1** `poller` 与 `timer-worker` **各自**一个单实例命名空间；两者可以同时运行，互不阻塞。
- **R2** 启动时获取锁；拿不到就非 0 退出，文案说明「已有实例在运行」，不打印敏感信息。
- **R3** 进程正常退出、`kill -9`、掉电后锁都必须自动失效；不允许依赖手工删 pidfile。
- **R4** 不新增外部服务。数据库本来就是必需依赖，优先用 PostgreSQL 会话级 advisory lock；
  持锁连接必须与进程同生命周期，不能从池里借一条随用随还。
- **R5** SIGTERM 顺序：先停循环 / 等在途一轮结束，再关连接释放锁；退出码不变。
- **R6** 锁的范围是「同一个数据库」，不是「同一台机器」：同库不同机器也只能有一个实例。

## Acceptance Criteria

- [ ] 同库启动第二个 poller 被拒绝，退出码非 0，文案说明已有实例。
- [ ] `kill -9` 第一个 poller 后，第二个可以正常启动（无需手工清理）。
- [ ] poller 与 timer-worker 可以同时运行，互不拒绝。
- [ ] SIGTERM 后锁已释放，可立即重启。
- [ ] `pnpm run check` 全绿。

## Out of Scope

- 多实例并发调度 / 分池 / 主从选举 / 故障转移。
- 跨数据库的全局锁。
- 控制台展示锁状态（可后续加只读视图）。
