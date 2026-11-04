# 修复工作区基线与生命周期逻辑（P0+P1）

> 来源：2026-11-04 对工作区 / 基线 / 生命周期的一次整体 review。
> 范围：P0-1 / P0-2 / P0-3 + P1-4 / P1-5 / P1-6 / P1-7，共 7 项。
> 不在本任务内的问题见 Out of Scope。

## Goal

让工作区的「位置、基线、清理、恢复」在崩溃、换目录、重放、手动删除等真实场景下
仍然可解释：事件流记录的事实必须与磁盘 / 分支的真实状态一致；失败要如实记账，
不能把「没做成」写成「已做成」。

## Background

- 工作区不是每次克隆一份，而是持久对象库 + 每 Task 一个 worktree；
  基线是 prepare 时解析的 40 位 SHA（`src/fact/git-workspace.ts`）。
- `CreateBranch` 事件是 PR 起点的审计证据；证据一旦写错，后续重放会一直沿用。
- 终态、崩溃恢复、手动删除都会让 worktree 目录与 git 元数据不同步；
  当前实现有几处把「目录存在」当成「状态正确」。
- `KEEL_HOME` 默认值依赖 cwd，blob 根又独立于 `KEEL_HOME`，换目录启动会分叉。

## Review Findings

| ID | 问题 | 后果 |
|---|---|---|
| P0-1 | `ensureWorktree` 复用已有分支时仍返回 `created: true`，`CreateBranch` 把本次 `baseSha` 写成分支起点 | 审计证据伪造；后续重放继续沿用 |
| P0-2 | 模拟 CI 写 `CIPassed` / `CIFailed` 时没有来源字段 | 事件流分不清真 CI 与模拟结果 |
| P0-3 | `resolveKeelHome` 依赖 cwd；`blobRoot` 又独立于 `KEEL_HOME` | 换目录启动出现第二个 `.keel`，大产物读不回 |
| P1-4 | T-015 / T-024 不清理 worktree | 终态任务留下工作树，长期堆积 |
| P1-5 | `cleanWorkspace` 忽略 `remove()` 的 Result，永远写 `SideEffectApplied` | 清理失败被记成成功 |
| P1-6 | `ensureWorktree` 只看 `existsSync`，不 prune 陈旧元数据 | worktree 被外部删除后任务永久卡在 `worktree_failed` |
| P1-7 | SIGKILL 留下的 mkdir 锁没有恢复入口 | poller 永远 `lock_timeout`，只能手工猜路径 |

## Requirements

### R1 基线证据不伪造（P0-1）

- `ensureWorktree` 必须区分「worktree 新建」与「分支新建」。
- worktree 被删后复用已有分支时，`CreateBranch` 的 `base_sha` 必须沿用该分支
  上一次记录的真实起点；没有历史记录时写 `null`，不得写本次 `prepareProject.baseSha`。
- `reused` 的语义改为「分支是否复用」，与 worktree 是否新建解耦。

### R2 CI 结果可区分来源（P0-2）

- 所有 `CIPassed` / `CIFailed` 事件必须携带 `source`，取值为 `simulated` 或 `github`。
- 该值必须落到 `TaskStatusChanged.payload.source`，使事件流不读代码就能回答
  「这次 CI 是真跑的，还是模拟的」。
- 不改变 CLI 缺省值：`run-task` / `run-issue` 仍缺省 `passed`；
  缺省值是否改成 `real` 是单独的产品决策，不在本任务内。

### R3 项目根稳定（P0-3）

- 未显式设置 `KEEL_HOME` 时，从 cwd 向上查找：
  最近的已有 `.keel` 目录优先；否则最近的 `.git` 目录所在层作为项目根；
  都没有才退回 `<cwd>/.keel`。
- 显式 `KEEL_HOME` 仍然最高优先级，按 cwd 解析（保持现有语义）。
- 默认 blob 根跟随 `KEEL_HOME`（`<KEEL_HOME>/blob`），不再独立使用 cwd 相对的
  `.keel/blob`；显式 `KEEL_BLOB_DIR` 仍然最高优先级。
- 在项目树内从任意子目录启动，必须命中同一个项目根；项目树外启动仍需显式
  `KEEL_HOME`，本任务不引入全局注册表。

### R4 终态清理工作区（P1-4）

- `T-015`（人工驳回）与 `T-024`（CI 通过 → S-DONE）必须包含 `CleanWorkspace`。
- 清理只移除 worktree 目录，保留分支与提交历史。
- `T-041`（S-FAILED）继续保留现场；`T-027` / `T-040` 的清理语义不变。

### R5 清理失败如实记账（P1-5）

- `GitWorkspace.remove` 必须返回 `Result`，不得以抛异常作为失败出口。
- 清理失败时写 `SideEffectIntent`（含失败原因），不得写 `SideEffectApplied`。
- 清理失败不得回滚已经成立的终态（S-DONE / S-REJECTED）；事实已成立，
  副作用可以稍后重试。

### R6 worktree 可恢复（P1-6）

- worktree 目录被外部删除、但 git 仍保留注册信息时，`ensureWorktree` 必须
  在 `worktree add` 失败后 `worktree prune` 并重试一次，而不是永久卡在
  `worktree_failed`。
- 路径存在但不是 worktree 根、或位于错误分支时，必须 fail closed：
  返回带路径与期望 / 实际分支的错误，不删除目录（可能含未提交内容）。

### R7 锁死恢复入口（P1-7）

- 提供 `keel unlock <repoId> [--force]`：无 `--force` 只报告持有者并拒绝；
  `--force` 才删除锁目录。
- `lock_timeout` 错误必须给出这条命令，避免运维只能靠猜。
- 不自动破锁：`mkdir` 锁无法无竞争地判断「持有者已死」，自动删除会引入
  双重持锁窗口；显式入口是当前机制下最小的安全方案。

## Acceptance Criteria

- [x] worktree 被删后重放 `CreateBranch`，`base_sha` 等于首次记录值（或 `null`），
      不等于本次 `prepareProject.baseSha`；`reused=true`。
      → `effects.test.ts`「worktree 被删后重放」「没有历史事件」「重放」「基线前进后重跑」
- [x] 模拟 CI 与真实 CI 的 `TaskStatusChanged.payload.source` 分别为
      `simulated` / `github`；缺省 CLI 行为不变。
      → `driver.test.ts`、`ci-wiring.test.ts`
- [x] 同一项目树内从根目录与子目录分别解析 `KEEL_HOME`，得到同一路径；
      默认 blob 文件落在 `<KEEL_HOME>/blob` 下。
      → `project-root.test.ts`「同一棵树内不同子目录解析到同一个根」、`blob.test.ts`
- [x] `T-015` / `T-024` 的 effects 含 `CleanWorkspace`；转移后 worktree 目录消失、
      分支仍存在。
      → `transition.test.ts`「终态清理」、`effects.test.ts`「成功：…」、`decide.test.ts`「已有工作树」
- [x] `remove` 失败时事件流出现 `SideEffectIntent`，任务仍到达终态。
      → `effects.test.ts`「失败：写 SideEffectIntent…」；任务终态由 `driver.test.ts` 覆盖
- [x] 删除 worktree 目录后再次 `ensureWorktree` 成功，且复用原分支；
      路径被普通目录占用时返回明确错误且不删除。
      → `git-workspace.test.ts`「worktree 被外部删除后重建」「路径被普通目录占用」「checkout 在别的分支」
- [x] `keel unlock` 无 `--force` 拒绝、有 `--force` 删除；`lock_timeout` 文本含该命令。
      → `unlock.test.ts`、`file-lock.test.ts`（hint）
- [x] `pnpm run check` 全绿；无数据库迁移、无新依赖。
      → 2026-11-04：50 files / 700 tests passed，exit 0

## Constraints

- 不改变转移表的 `from` / `to` / `guard`；只改 effects（C4 检查仍然通过）。
- 不改变 `CreateBranch` / `CleanWorkspace` 的幂等键与事件类型。
- 所有新增错误沿用 `WORKSPACE_ERROR` 与既有 `WorkspaceFailureCode`；
  如新增字段，必须同步 `src/fact/workspace-error.ts` 与 spec。
- 不删除可能含未提交内容的目录；清理失败优先保留现场。
- 不把密钥、token 写进事件或错误 detail。

## Out of Scope

- 把 CI 缺省从 `simulated` 改成 `real`。
- 自动 merge 的真实实现（当前只记意图）。
- 旧分支的 rebase / merge 基线。
- `git add -A` 的密钥扫描。
- harness 子进程的环境变量继承与 token 收敛。
- 8 位 task 前缀的分支碰撞。
- `register-repo` 的并发重复注册。
- 全局并发上限可配置化。
- 终态 task 仍会执行 prepare 的优化。
