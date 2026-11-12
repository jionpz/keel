# ADR-0012 · S-DONE 以 PR 合并为准，未合并关闭不占死 issue

**Status**: **Accepted** — 2026-11-12，按 issue #132 推荐方案 A 落地
**Date**: 2026-11-12
**Related**: issue #132、#129、#130；`T-024` / `T-027` / `T-042`；`PRMerged` / `PRClosed`

## Context

legacy 路径把 `CIPassed` 直接当成完成：PR 的 CI 一绿，Task 就进入 `S-DONE`。
这制造了两个事实错误：

1. **完成语义不对。** 对提 issue 的人来说，完成是 PR 已合并（配合
   `Closes owner/repo#n` 关单），不是「CI 绿了，等别人点 merge」。
2. **未合并关闭会卡死。** PR 被关闭而 issue 仍 open 时，Task 已经是终态
   `S-DONE`；`feedback(source, external_ref)` 唯一键又让 poller 不会为同一
   issue 创建新 Task，于是 issue 再也不会被驱动。

GitHub 已经提供 PR 的 `merged` / `merged_at` / `merge_commit_sha` / `closed_at`，
这是可直接读取的外部事实，不需要 Keel 自己推断。

## Options

| 选项 | 机制 | 评价 |
|---|---|---|
| **A. S-DONE = 已合并** | `CIPassed` 自环记录事实；观察 PR 后 `PRMerged → S-DONE`、`PRClosed → S-ABANDONED` | 语义正确；需要 poller 持续观察 PR，并为未合并关闭补重驱动 |
| B. 保留 S-DONE = CI 绿 | 终态后继续记录 `PRMerged` / `PRClosed` | 改动小；但「完成」仍不等于合并，且终态后写事件会破坏终态边界 |

## Decision

**A。**

1. `CIPassed` 不再进入 `S-DONE`，改走 `T-042` 自环；事件 payload 记录
   `source` 与 `head_sha`，Task 留在 `S-PR_OPEN`。
2. poller 每轮观察 `S-PR_OPEN` 的 PR：
   - `merged=true` → `PRMerged` 走 `T-024` → `S-DONE`，记录 `merged_at` 与
     `merge_sha`；
   - `closed=true ∧ merged=false` → `PRClosed` 走 `T-027` → `S-ABANDONED`，
     记录 `reason='pr_closed_unmerged'` 与 `closed_at`；
   - `open` → 停在 `S-PR_OPEN`。
3. `S-PR_OPEN` 任务即使不在 open issue 列表里（PR 合并后 `Closes #n` 自动关单）
   仍要继续观察。
4. 未合并关闭后，若 issue 仍 open 且带注册 label，允许为同一 issue 开新 Task：
   - 复用原 GitHub Feedback；
   - 追加不可变 manual Feedback `redrive:<previousTaskId>`，把上一轮 PR URL、
     关闭时间与关闭原因带进 PM 上下文；
   - poller 自动触发，`keel run-issue <url> --redrive` 作为手动入口。
5. 自动合并仍不在范围内；`MaybeAutoMerge` 不再挂在完成转移上。
6. 先观察真实 PR 的合并/关闭终态，再处理仍 open 的 CI，避免已关闭 PR 被 CI
   阻塞或误触发返工。所有 PR 事件带 `source=github|simulated`，模拟结果不回写 Issue。

## Consequences

### 正面

- `S-DONE` 的含义变成可向用户解释的「PR 已合并」；merge SHA 可从事件流查到。
- PR 未合并关闭后 issue 不会卡死；重驱动有明确门槛与上下文。
- issue 因合并自动关闭不会丢掉 PR 收口：`S-PR_OPEN` 有独立观察列表。

### 代价与边界

1. **poller 必须常驻**才能观察合并/关闭；一次性 `keel run-task` 会停在
   `awaiting-pr-merge`。这是「等外部事实」的正常停靠，不是失败。
2. **模拟模式**为保持本地闭环，在只注入 `externalCi` 时把 PR 视为已合并；
   真实 `--ci real` 必须走 `PullRequestStateGateway`，不得合成合并事实。
3. **issue 评论回写**（merged / abandoned 两种评论）依赖 #130 的写网关；
   本 ADR 只定义状态与事实，不复制写网关。
4. managed 路径的 `PR_READY` 语义不变，另议。

## 实现锚点

- `src/control/transition/table.ts` — T-024 / T-027 / T-042
- `src/control/orchestrator/loop.ts` — CI 事实复用与 PR 观察
- `src/contracts/pull-request-state.ts` — `PullRequestStateGateway`
- `src/fact/github-provider.ts` — `getPullRequest`
- `src/ingress/poller.ts` — S-PR_OPEN 任务列表与重驱动候选
- `src/ingress/redrive.ts` — 重驱动门槛与 PM 上下文
- `src/control/driver/driver.ts` — 合并/关闭事件 payload 与重驱动 intake

## 验证

- 转移表与 `docs/04-state-machine.md` 由 `pnpm run check:transitions` 双向比对；
- `GitHubProvider.getPullRequest` 由 stub HTTP server 单测覆盖；
- 编排器确定性测试覆盖 CI passed 后仍 S-PR_OPEN、PR merged → S-DONE、
  PR closed unmerged → S-ABANDONED；
- 数据库测试覆盖重驱动的新 Task、Feedback 复用与幂等。
