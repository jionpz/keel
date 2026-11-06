# 执行计划：poller 扫描与驱动解耦

> 依赖 `prd.md` / `design.md`。每步结束都跑对应验证，不把红灯留到下一步。

## 0. 前置

- [x] 任务已创建（`.trellis/tasks/11-06-poller-nonblocking`）
- [ ] `task.py start` 后进入 in_progress

## 1. 抽出 `scanOnce`，保留 `pollOnce` 行为

**改动** `src/ingress/poller.ts`：

- 从 `pollOnce` 抽出扫描段为内部 `scanOnce(deps, opts)`，返回 `{ stats, drives, stopped }`。
- `scanOnce` 只负责：repo 遍历、remote 解析、`listIssues`、终态查询、轮内 `externalRef` 去重、
  `repo_error` 日志。**不调用** `runIssue`。
- `pollOnce` 改为 `scanOnce` + 顺序 `await deps.runIssue`，聚合 `ingested / driven / errors`，
  继续输出原 `poll` 聚合行。

**验证**：

```bash
pnpm vitest run src/ingress/poller.test.ts
```

- [ ] 既有 12 个 `pollOnce` 用例全绿（行为无变化）

**回滚点**：本步只做等价重构，可独立回退。

## 2. 新增有界调度器 `createDriveScheduler`

**改动** `src/ingress/poller.ts`：

- 新增 `DEFAULT_DRIVE_CONCURRENCY = 3`、`DriveRequest`、`ScheduleOutcome`、`DriveScheduler`、
  `createDriveScheduler`。
- 实现 `schedule` 的四态判定、`inFlight` 集合、成功/失败日志、首个 fatal 记录 + `onFatal`、
  `drain()`、`takeFatal()`。
- 复用现有 `safeDetail` 脱敏（抽成可复用的小工厂，避免复制 token 处理逻辑）。
- 导出 `issue_driven` 成功日志。

**验证**：

```bash
pnpm vitest run src/ingress/poller.test.ts
pnpm run typecheck
```

- [ ] 新增调度器单测：并发上限、in_flight 去重、at_capacity、drain、fatal
- [ ] 驱动失败仍走 `issue_error` 且 detail 脱敏

## 3. 常驻循环改为扫描/驱动解耦

**改动** `src/ingress/poller.ts`：

- `RunPollerForeverOptions` 增加 `concurrency?: number`。
- `runPollerForever` 使用 `scanOnce` + `scheduler`：
  - 每轮只扫描、调度、打 `poll` 行（`scheduled / deferred / inFlight`）；
  - interval 等待与驱动解耦；
  - SIGTERM 后不再调度，`finally` 中 `drain()`；
  - fatal 先停止、等在途收尾、再抛出；正常退出才打 `poller stopped`。
- 保持 `StopToken` 订阅数不随轮次增长。

**验证**：

```bash
pnpm vitest run src/ingress/poller.test.ts
```

- [ ] 慢驱动不阻塞后续轮扫描（deferred/后续 issue 调度测试）
- [ ] SIGTERM 后不再调度，且在途驱动结束后才退出
- [ ] 同一 ref 跨轮不双跑
- [ ] 既有生命周期 / 订阅数测试仍绿

## 4. CLI `--concurrency`

**改动** `src/cli/poller.ts`：

- 引入 `DEFAULT_MAX_RUNNING_RUNS`。
- 新增 `parseConcurrency(raw): Result<number>` 并导出（便于单测）。
- `pollerMain` 校验并透传 `concurrency`；HELP 增加说明。
- 非法值：0 / 负数 / 小数 / 非数字 / 只写标志 / 大于全局上限 → 退出码 1，零副作用。

**验证**：

```bash
pnpm vitest run src/cli/poller.test.ts
```

- [ ] 缺省 = 3；合法值透传；六类非法值拒绝
- [ ] 既有参数 / 锁 / 连接池测试不回归

## 5. 文档与 spec 同步

**改动**：

- `README.md` 的 poller 行为约定：顺序驱动 → 有界并发、扫描节奏独立、日志字段；
- `.trellis/spec/backend/ingress-poller.md`：Signatures、Contracts（幂等 / 信号 / 日志）、
  Validation 矩阵、Tests Required、已知边界；
- 如涉及架构表述，补 `docs/08-cross-cutting.md` §4.3 的 poller 使用说明（不改变 N3/N4）。

**验证**：

- [ ] README 与 spec 中不再出现「顺序处理更容易诊断」「轮内驱动到停」等失效表述
- [ ] 新日志字段在 spec 的 JSON 示例中可见

## 6. 全量质量门

```bash
pnpm run check
```

- [ ] lint / typecheck / boundaries / generated / transitions / purity / workflow 全绿
- [ ] 测试全绿（预期 924+ 用例，无新增 skip）
- [ ] 反例验证：分别回退「并发上限」「in-flight 去重」「fatal 传播」「SIGTERM 不调度」，
      确认对应测试先红后绿

## 7. 收尾

- [ ] `trellis-check` 复核无 P2 遗留
- [ ] 更新 `.trellis/spec/backend/ingress-poller.md` 的「已知边界」
- [ ] journal 记录决策、验证与遗留
- [ ] 归档任务（`task.py archive`）

## 检查点

| 检查点 | 位置 | 不通过就不进入 |
|---|---|---|
| CP1 | 步骤 1 后 | 既有 pollOnce 测试全绿 |
| CP2 | 步骤 2 后 | 调度器单测 + typecheck 绿 |
| CP3 | 步骤 3 后 | 生命周期/慢任务/去重测试绿 |
| CP4 | 步骤 4 后 | CLI 拒绝矩阵绿 |
| CP5 | 步骤 6 后 | 全量 check 绿 |
