# 执行计划 · 本地项目绑定与同步基线

> 本计划只覆盖**开工链路**：绑定、持久根、同步、基线证据。
> PR / CI 收尾链路不改。所有步骤完成前不进入 `task.py start` 之后的实现阶段。

## Step 0 · 决策门（不改代码）

先确认四个默认值；若评审改选，只影响 Step 2 / Step 3。

- [ ] **D1 命令形态**：默认扩展 `keel register-repo <remoteUrl> --local-path <dir>`，不新增命令。
      理由：少一个入口，且绑定本身就是注册的一部分。
- [ ] **D2 attached 模式对象库**：默认直接使用用户仓库作为 git 目录，
      worktree 放在 `<KEEL_HOME>/worktrees/<task_id>`；不额外维护 bare 镜像。
      理由：不产生第二份克隆；隔离仍由 worktree 保证。
- [ ] **D3 本地未推送提交**：默认忽略，基线始终取 `origin/<base>`；
      `keel status` 报告 `diverged`，不自动包含、不自动 rebase。
- [ ] **D4 离线模式**：v1 不提供 `--no-fetch`；同步失败即 fail-closed。
- [ ] **D5 并发控制**：用 `<KEEL_HOME>/locks/repo-<id>.lock` 目录的原子 `mkdir` 锁，
      粒度为 per-repo，等待 30s，不自动破锁。不引入 `proper-lockfile`。
- [ ] **D6 路径规范化**：绑定与运行都先 `resolve` 再 `realpath`；DB 只存规范绝对路径。
      `KEEL_HOME` 相对值时按进程启动 cwd 解析一次并固化。
- [ ] **D7 基线锚点**：worktree 用 40 位 `baseSha` 创建，不用 `origin/<base>` ref 名，
      防止 prepare 与 add 之间 ref 被并发 fetch 移动。

## Step 1 · 数据模型与迁移

- [ ] 新增 `migrations/1000000000005_repo_local_path.sql`：
  ```sql
  ALTER TABLE repo ADD COLUMN local_path text;

  -- 第二道防线：落库值必须是绝对路径（第一道是应用层 realpath）
  ALTER TABLE repo ADD CONSTRAINT repo_local_path_absolute
    CHECK (local_path IS NULL OR local_path LIKE '/%');

  CREATE UNIQUE INDEX repo_local_path_unique
    ON repo (local_path) WHERE local_path IS NOT NULL;
  ```
- [ ] 迁移注释写清：唯一索引只能保证「规范化后的字符串不重复」，
      规范化由 `src/fact/project-root.ts` 的 `canonicalizeDir` 在写入前完成。
- [ ] 确认 `repo` 的 GRANT 不变：`keel_control` / `keel_execution` / `keel_ingress`
      仍然只有 `SELECT`；绑定写入继续走 `asOwner`（管理操作，与 `register-repo` 一致）。
- [ ] 更新读取 `repo` 的查询，至少覆盖：
      `src/cli/register-repo.ts`、`src/cli/run-task.ts`、`src/cli/console.ts`。
- [ ] 新增迁移测试或复用 `src/fact/invariants.test.ts` 风格：
      1. 同一 `local_path` 绑定第二个 repo 必须被唯一索引拒绝；
      2. `local_path` 写入相对路径必须被 `repo_local_path_absolute` 拒绝。

**验证**

```bash
DATABASE_URL=postgres://localhost/keel_dev pnpm run db:migrate
pnpm exec vitest run src/fact
```

**Review gate**：迁移 diff 只增加列与索引；没有改 GRANT，没有把运行态写进 `repo`。

**回滚点**：`pnpm exec node-pg-migrate down`（回退一版）；测试库可直接 `pnpm run db:reset`。

## Step 2 · 路径基础件与绑定命令

- [ ] 新增 `src/fact/workspace-error.ts`：
  ```ts
  type WorkspaceFailureCode =
    | 'local_path_missing' | 'not_a_git_worktree' | 'origin_mismatch'
    | 'local_path_taken'   | 'git_dir_invalid'    | 'fetch_failed'
    | 'base_missing'       | 'lock_timeout'       | 'worktree_failed'

  workspaceError(code, fields): KeelError
  // 产出 WORKSPACE_ERROR，detail 固定为 [code] k="v" ... 形式
  ```
- [ ] 新增 `src/fact/project-root.ts`：
  - `resolveKeelHome(env?, cwd?)`：`resolve` → `mkdir -p` → `realpath`；
  - `canonicalizeDir(input, cwd?)`：`resolve` → 校验目录存在 → `realpath`；
  - 两者失败都返回 `Result`，不抛异常。
- [ ] 扩展 `src/cli/register-repo.ts`：新增可选参数 `--local-path <dir>`。
- [ ] 校验全部在**事务外**完成，任一失败即拒绝且零写入：
  1. `canonicalizeDir` 成功（目录存在）；
  2. `git -C <dir> rev-parse --is-inside-work-tree` 为 true；
  3. `git -C <dir> remote get-url origin` 存在；
  4. 归一化后与注册的 `remote_url` 一致（复用 `src/fact/remote-url.ts`）。
- [ ] 写入语义（`asOwner` 单事务，命中行 `FOR UPDATE`）：
  - remote 不存在 → `INSERT`（含规范化 `local_path`）；
  - remote 存在 + 未传 flag → 原样返回，**不写库**；
  - remote 存在 + 传了 flag → 规范化路径与现值相同则 no-op，否则
    `UPDATE repo SET local_path = $1 WHERE id = $2`。
- [ ] 捕获唯一索引冲突 `23505`：回滚后反查 `SELECT id FROM repo WHERE local_path = $1`，
      返回 `[local_path_taken] path="..." repo="<当前>" occupied_by="<占用者>"`。
- [ ] 更新 `src/cli/index.ts` 的顶部文档注释与 `HELP` 模板：
      `register-repo <remoteUrl> [--default-branch <name>] [--local-path <dir>]`。
- [ ] 错误信息必须包含：固定 code、当前路径/URL、下一步命令。

**验证**

```bash
pnpm exec vitest run src/cli/register-repo.test.ts src/cli/cli.test.ts \
  src/fact/project-root.test.ts src/fact/workspace-error.test.ts
```

**新增测试**（真实临时 git 仓库，不 mock）：
- 合法目录 + 匹配 remote → 成功，DB 里是 `realpath` 后的绝对路径；
- 目录不存在 / 非 git / remote 不匹配 → 非 0，零写入，detail 前缀分别为
  `[local_path_missing]` / `[not_a_git_worktree]` / `[origin_mismatch]`；
- 路径别名：`<dir>`、`<dir>/`、`<dir>/./`、`..` 相对路径、指向 `<dir>` 的符号链接
  → 规范化后全部相同；用别名二次绑定被唯一索引拒绝；
- 重复绑定同一 remote 不带 flag → 幂等且原 `local_path` 不变；
- managed → attached：先无 flag 注册，再带 flag 绑定 → `local_path` 写入；
- attached → 新路径：更新成功，旧路径释放；
- 同一 canonical path 绑定第二个 repo → `[local_path_taken]` 且含两个 repoId；
- 校验失败（remote 不匹配）时，已有绑定保持原值；
- `cli.test.ts` 断言 `HELP` 的 `register-repo` 行包含 `--local-path`。

**Review gate**：没有把 `local_path` 写进任何非 `repo` 表；没有新增运行角色；
所有失败路径都有固定 code，测试按前缀断言而不是整段文案。

**回滚点**：`git checkout -- src/cli/register-repo.ts src/cli/index.ts`。

## Step 3 · GitWorkspace 改为项目绑定模型

- [ ] 在 `src/fact/git-workspace.ts` 引入：
  ```ts
  type ProjectBinding =
    | { mode: 'managed'; root: string; repoId: string }
    | { mode: 'attached'; localPath: string; repoId: string }

  interface PreparedProject {
    gitDir: string
    baseRef: string   // refs/remotes/origin/<base>
    baseSha: string
    fetchedAt: string
  }
  ```
- [ ] 构造函数默认 root 从 `'.keel'` 改为 `resolveKeelHome()`，消除 cwd 依赖。
- [ ] 新增 `src/fact/file-lock.ts`：
  ```ts
  withFileLock<T>(lockDir, opName, fn, opts?): Promise<Result<T>>
  // mkdir 原子获取；EEXIST 每 50ms 重试；默认 30s 超时；
  // 锁内写 owner.json { pid, host, started_at, op }；
  // 超时返回 [lock_timeout]，不自动删锁。
  ```
- [ ] `GitWorkspace` 增加 `withRepoLock(repoId, op, fn)`，锁路径
      `<root>/locks/repo-<repoId>.lock`；`prepareProject` 与 `ensureWorktree`
      各自取锁，锁内不嵌套调用取同一把锁的函数。
- [ ] 新增 `ensureGitDir(binding, remoteUrl)`（仅 managed）：
  - 目标存在 → `git -C <bare> rev-parse --is-bare-repository` 为 `true` 才复用；
    否则 `[git_dir_invalid]`，**不自动删除**；
  - 目标不存在 → clone 到 `<root>/repos/.tmp-<repoId>-<pid>`，成功后 `rename`。
- [ ] 新增 `syncBase(gitDir, baseBranch)`：显式 refspec + `--prune` + `rev-parse`；
      fetch 失败 → `[fetch_failed]`；ref 不存在 → `[base_missing]`。
- [ ] 新增 `prepareProject(binding, remoteUrl, baseBranch)`：
  - `attached`：对 `localPath` 再跑一次 `canonicalizeDir` 与 origin 校验；
  - `managed`：`ensureGitDir`；
  - 两种模式都执行 `syncBase`；
  - 全程在 `withRepoLock` 内。
- [ ] `ensureWorktree(project, taskId)`：
  - 路径存在 → 返回 `created=false`，不 rebase、不移动分支；
  - 不存在 → `git worktree add -b <branch> <wt> <project.baseSha>`
    （**用 commit，不用 `baseRef`**）；
  - 全程在 `withRepoLock` 内。
- [ ] `push` / `headSha` / `remove` / `preservePath` 全部改用 `gitDir`。
- [ ] 保留 managed 模式旧行为：没有 `local_path` 的 repo 不改变外部语义。

**验证**

```bash
pnpm exec vitest run src/fact/git-workspace.test.ts src/fact/file-lock.test.ts
```

**新增测试**：
- managed：首次 clone、第二次复用、fetch 后 base 前进；
- managed 半成品：目标目录存在但不是 bare → `[git_dir_invalid]`，不复用；
- attached：用户目录作为 gitDir、worktree 仍在 `.keel` 下、用户工作树不变；
- 负对照：目录不存在、remote 不匹配、远端不可达、base 不存在，detail 前缀正确；
- 幂等：重复 `ensureWorktree` 返回 `created=false`；
- 锚点：prepare 得到 `baseSha` 后再手动 fetch 移动 `origin/<base>`，
  创建出的 worktree HEAD 仍等于原 `baseSha`；
- 并发（真实 git + 真实 `mkdir` 锁，`Promise.all`）：
  1. 首次 `prepareProject` 两次并发 → 只 clone 一次，无 `.tmp-*` 残留；
  2. 两次并发 fetch → 串行完成，无 `index.lock` 错误；
  3. 同 task 并发 `ensureWorktree` → 一个 `created=true`，另一个 `false`；
  4. 锁目录已被占用且超时 → `[lock_timeout]`，无状态写入。

**Review gate**：`git-workspace.test.ts` 的 N1 / S1 断言全部保持通过；
新增测试中至少有一条**用户工作树前后完全一致**的断言；
并发用例不是「跑两次不报错」就算过，必须断言 clone 次数与 `created` 值。

**回滚点**：`git checkout -- src/fact/git-workspace.ts src/fact/git-workspace.test.ts src/fact/file-lock.ts`。

## Step 4 · 接线 run-task / run-issue / orchestrator

- [ ] `src/cli/run-task.ts`：
  - 删除 `mkdtempSync(tmpdir(), 'keel-cli-')`；
  - 项目根改用 `resolveKeelHome()`（不再直接读 `process.env.KEEL_HOME`）；
  - 读取 repo 时增加 `local_path`，构造 `ProjectBinding`；
  - 调用 `prepareProject`，把整个 `PreparedProject` 传入 `WorkspaceBinding`；
  - 同步失败直接返回 `WORKSPACE_ERROR`，不创建 run。
- [ ] `src/control/driver/driver.ts`：`WorkspaceBinding` 从
      `{ git, repoId, baseBranch }` 改为 `{ git, project, repoId }`。
- [ ] `src/control/driver/effects.ts`：`CreateBranch` 改用 `ctx.workspace.project`
      调 `ensureWorktree`（本步只改调用签名，payload 扩展在 Step 5）。
- [ ] `src/control/orchestrator/loop.ts`：
  - `OrchestratorWorkspace` 的 `worktree` 分支改为
    `{ mode: 'worktree'; git; repoId; project: PreparedProject }`；
  - `resolveWorkspace`（约 :644）改为 `ensureWorktree(ws.project, taskId)`；
  - `headSha` 调用点（约 :219）改为 `headSha(ws.project, taskId)`。
- [ ] 更新所有 `mode: 'worktree'` fixture：
      `src/e2e/orchestrator-workspace.test.ts`、`src/e2e/collect-changes.test.ts`、
      `src/control/orchestrator/ci-wiring.test.ts`、`src/cli/run-task.test.ts`。
- [ ] `src/cli/run-issue.ts`：不重写驱动主体；确认它通过 `runTask` 自动获得新行为。
- [ ] `.gitignore` 增加 `.keel/`（运行时项目根，不入库）。

**验证**

```bash
pnpm exec vitest run src/cli/run-task.test.ts src/cli/run-issue.test.ts \
  src/e2e/orchestrator-workspace.test.ts src/e2e/collect-changes.test.ts \
  src/control/orchestrator/ci-wiring.test.ts
pnpm run typecheck
```

**新增测试**：
- 连续两次 run：第二次不再全量 clone，复用同一个项目根；
- 远端 base 前进后，新 task 的 worktree 起点是新 `base_sha`；
- `resolveWorkspace` 走 worktree 分支时返回 `project` 对应的目录，
  `fixed` 分支行为不变；
- `S-PR_OPEN` 的真实 CI 分支读到的是 worktree HEAD，与 `headSha(project, taskId)` 一致；
- `keel status` 前 Task 状态与事件数与改动前一致（回归）。

**Review gate**：`orchestrator-workspace.test.ts` 的 N1 / S1 全绿；
没有把 worktree 放进用户工作树目录；
`loop.ts` / `effects.ts` / `driver.ts` 三处对 workspace 的用法一致，无残留 `baseBranch`。

**回滚点**：`git checkout -- src/cli/run-task.ts src/control/driver/driver.ts src/control/driver/effects.ts src/control/orchestrator/loop.ts`。

## Step 5 · 基线证据与重放

- [ ] `src/control/driver/effects.ts` 的 `CreateBranch` 副作用扩展 payload：
  ```json
  {
    "kind": "CreateBranch",
    "dedupe_key": "ai/task-xxxxxxxx",
    "branch": "ai/task-xxxxxxxx",
    "worktree": "...",
    "base_ref": "refs/remotes/origin/main",
    "base_sha": "<40 hex>",
    "fetched_at": "2026-10-27T12:00:00.000Z",
    "reused": false
  }
  ```
- [ ] 重放语义：`ensureWorktree` 返回 `created=false` 时，读取该 task 最近一条
      `CreateBranch` 事件，复用其 `base_sha`，并写 `"reused": true`；
      不重新计算基线，不移动分支。
- [ ] 老 task 没有历史 `CreateBranch` 事件时，`base_sha` 写 `null`，不伪造。

**验证**

```bash
pnpm exec vitest run src/control/driver/effects.test.ts \
  src/control/driver/driver.test.ts src/e2e/orchestrator-workspace.test.ts
```

**新增测试**：
- 首次建分支：payload 含 `base_ref` / `base_sha` / `fetched_at`，`reused=false`；
- 重放：`reused=true`，`base_sha` 与首次一致；
- 基线前进后重跑：仍复用旧 `base_sha`，不把旧分支改基。

**Review gate**：事件流里能回答「这次 PR 从哪个 commit 长出来」。

**回滚点**：`git checkout -- src/control/driver/effects.ts`。

## Step 6 · `keel status` 展示绑定与基线

- [ ] `src/cli/status.ts` 增加：
  - 绑定模式（`managed` / `attached`）；
  - `local_path`：优先显示 `canonicalizeDir` 后的值；失败则原样显示并标注 `(unresolved)`；
  - 最近一条 `CreateBranch` 的 `base_ref` / `base_sha` / `fetched_at`；
  - 本地状态：`dirty` / `diverged`（attached 模式才计算，只读 `git status` / `git rev-list`）。
- [ ] 不改变现有 task / run / events 输出格式；新增内容追加在尾部。

**验证**

```bash
# 新增 src/cli/status.test.ts 后执行
pnpm exec vitest run src/cli/status.test.ts
# 或用真实 task 手工核对
pnpm run status -- <task_id>
```

**Review gate**：输出不包含 token、凭据或完整事件 payload。

**回滚点**：`git checkout -- src/cli/status.ts`。

## Step 7 · 规范与文档

- [ ] 更新 `.trellis/spec/backend/git-workspace.md`：
      managed / attached 两种模式、fetch refspec、worktree 位置、重放语义。
- [ ] 更新 `.trellis/spec/backend/database-guidelines.md`：
      `repo.local_path` 的归属、唯一索引、仍然只读的授权矩阵。
- [ ] 更新 `README.md` 本地部署段：
      `register-repo --local-path`、`KEEL_HOME`、`keel status` 新增字段。
- [ ] 如果实现中改变了任何默认值，同步更新 `prd.md` 的 Open Questions 状态。

**Review gate**：文档描述的是**实际实现**，不是设计意图。

## Step 8 · 全量门禁与验收回归

- [ ] `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions / purity / test）。
- [ ] 负对照逐条验证，确认检查真的会红：
  1. 去掉 fetch → AC4 红；
  2. worktree 改用本地 `<base>` ref 名（而不是 `baseSha`）→ 锚点用例红；
  3. 去掉 `local_path` 校验 → AC2 红；
  4. 同步时 `git checkout` 用户分支 → AC5 红；
  5. 同步失败继续跑 → AC6 红；
  6. 去掉 `realpath`，直接存 `resolve()` 结果 → 路径别名用例红（AC11）；
  7. 去掉 per-repo 锁 → 并发 clone / worktree 用例红（AC12）；
  8. 去掉 `23505` 反查 → `[local_path_taken]` 用例因缺少 `occupied_by` 红（AC13）；
  9. 把 `loop.ts` 的 `resolveWorkspace` 改回旧签名 → typecheck 红（AC14）。
- [ ] 真实验收（需要环境变量）：
  ```bash
  unset KEEL_GITHUB_TOKEN
  export KEEL_GITHUB_TOKEN="$(gh auth token)"
  export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel
  pnpm run test:acceptance
  ```
- [ ] 真实 CLI 回归（可选，但建议至少跑一次）：
  ```bash
  DATABASE_URL=postgres://localhost/keel_dev pnpm run db:migrate
  KEEL_HOME=.keel pnpm exec tsx src/cli/index.ts run-issue <issue-url> --ci real --harness claude
  ```

**Review gate**：AC1–AC14 逐条有证据；失败项如实记录，不勾选。

## Step 9 · 提交

- [ ] 更新 spec 与文档后，按 Phase 3.4 提交。
- [ ] 建议拆成两个 commit：
  1. `feat(workspace): 本地项目绑定 + 开工前 fetch 基线`
  2. `docs(spec): 记录 managed/attached 工作区与 base_sha 语义`
- [ ] PR 描述附：绑定命令示例、`keel status` 输出样例、负对照结果。

## 依赖与顺序

```
Step 1 ──┬─> Step 2 ──┐
         └─> Step 3 ──┴─> Step 4 ──> Step 5 ──> Step 6
                                      └────────> Step 7
Step 1..7 ─────────────────────────────────────> Step 8 ──> Step 9
```

- Step 1 是唯一硬前置。
- Step 2 先落地 `project-root.ts` / `workspace-error.ts`，它们是 Step 3 的硬前置；
  之后「绑定命令」与 Step 3 可并行，但**不要同时改 `run-task.ts`**。
- Step 4 依赖 Step 3 的 `PreparedProject` 与 `ensureWorktree` 新签名。
- Step 4 之后才允许跑真实 CLI；之前只用单测与 e2e。
- 本任务没有父/子任务，所有验收在本任务内完成。

## 涉及文件清单

| 层 | 文件 |
|---|---|
| 迁移 | `migrations/1000000000005_repo_local_path.sql` |
| Fact | `src/fact/git-workspace.ts`、`src/fact/git-workspace.test.ts`、`src/fact/project-root.ts`、`src/fact/project-root.test.ts`、`src/fact/file-lock.ts`、`src/fact/file-lock.test.ts`、`src/fact/workspace-error.ts`、`src/fact/workspace-error.test.ts`、`src/fact/remote-url.ts` |
| CLI | `src/cli/register-repo.ts`、`src/cli/register-repo.test.ts`、`src/cli/index.ts`、`src/cli/cli.test.ts`、`src/cli/run-task.ts`、`src/cli/run-task.test.ts`、`src/cli/status.ts`、`src/cli/status.test.ts` |
| Control | `src/control/driver/driver.ts`、`src/control/driver/effects.ts`、`src/control/orchestrator/loop.ts`、`src/control/orchestrator/ci-wiring.test.ts`、相关 driver 测试 |
| e2e | `src/e2e/orchestrator-workspace.test.ts`、`src/e2e/collect-changes.test.ts` |
| Spec / Docs | `.trellis/spec/backend/git-workspace.md`、`.trellis/spec/backend/database-guidelines.md`、`README.md`、`.gitignore` |

## 明确不做

- 不改 `src/cli/console*`（控制台展示留给后续任务）。
- 不改 `src/control/transition/table.ts` 与状态机。
- 不改 PR / CI 网关。
- 不新增数据库角色，不改现有 GRANT。
- 不引入 `project` 表或项目切换器。

---

## 执行记录（2026-10-27）

Step 0–7 全部落地，文件与上表一致。`pnpm run check` 全绿：
42 个测试文件 / 530 passed，5 skipped（lint / typecheck / boundaries /
generated / transitions / purity / tests）。

### 负对照（9/9 复现红）

| # | 破坏方式 | 结果 |
|---|---|---|
| NC1 | 去掉 `syncBase` 的 fetch | 红（`远端前进后 baseSha 跟着前进`） |
| NC2 | worktree 用 `baseRef` 而非 `baseSha` | 红（锚点用例） |
| NC3 | 去掉 attached 目录校验 | 红（`origin_mismatch` 用例） |
| NC4 | prepare 时写用户工作树（`.keel-probe`） | 红（前后完全一致用例） |
| NC5 | 同步失败继续跑（`baseSha: 'HEAD'`） | 红（`base_missing` / `fetch_failed`） |
| NC6 | `canonicalizeDir` 去掉 `realpathSync` | **首轮绿** → 补符号链接用例后红 |
| NC7 | 去掉 per-repo 锁 | 红（并发 clone / worktree 用例） |
| NC8 | 去掉 `23505` 反查（`occupied_by` 变 unknown） | 红 |
| NC9 | `loop.ts` 的 `resolveWorkspace` 改回旧签名 | 红（typecheck） |

NC6 首轮为绿暴露的是**测试缺口**而非实现缺口：`resolve()` 本身已经消掉
`/a/./b`、尾斜杠与重复分隔符，原有别名用例测不到 `realpath` 独有的符号链接语义。
已在 `register-repo.test.ts` 增加「符号链接别名 → 解析成同一真实路径，撞唯一索引」，
再跑 NC6 即红。

### 真实验收

- `src/acceptance/github-pr.acceptance.test.ts`：通过（180s；真实 push → 建 PR →
  幂等复用 → 等 Actions 跑完回读 `passed`；finally 关闭 PR 并删远端分支）。
- 未跑：`v01-criterion-github` 与 `five-run`（整条 agent 流水线，单次 50–150s × N，
  属独立战役）。本次改动只触碰工作区准备层，已由单测 / e2e / PR 验收分层覆盖；
  失败项如实记录，不勾选。
