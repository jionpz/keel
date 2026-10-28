# 技术设计 · 本地项目绑定与同步基线

## 1. 边界与不变量

1. **repo 是 Fact Plane 的只读实体**：`keel_control` / `keel_execution` / `keel_ingress` 对它只有 `SELECT`。
   本地路径绑定属于管理操作，与 `register-repo` 一致，走 `asOwner` 写入，不新增角色。
2. **worktree 隔离不降级**（N1 / S1）：attached 模式下，Agent 仍然只在
   `<KEEL_HOME>/worktrees/<task_id>/` 里执行，绝不直接改用户的工作树。
3. **基线唯一且不可漂移**：每次 run 的代码起点是 prepare 时解析出的 `baseSha`；
   创建 worktree 直接锚定该 commit，不锚定会移动的 ref 名。
4. **幂等**：重复 run 复用已有 worktree 与分支，不移动基线、不重复建分支。
5. **路径只有一个规范形式**：所有落库与比较都使用「绝对路径 + `realpath`」；
   相对路径、尾斜杠、`..`、符号链接都收敛到同一字符串。
6. **共享 git 状态必须串行**：同一个 git 目录的 clone / fetch / worktree add
   不允许并发执行；跨进程与同进程用同一套机制。

## 2. 数据模型

新增迁移 `migrations/1000000000005_repo_local_path.sql`：

```sql
ALTER TABLE repo ADD COLUMN local_path text;

-- 第二道防线：落库值必须是绝对路径（第一道是应用层 realpath）
ALTER TABLE repo ADD CONSTRAINT repo_local_path_absolute
  CHECK (local_path IS NULL OR local_path LIKE '/%');

-- 一个本地目录只能绑定一个 repo，避免同一工作树被两个项目同时认领
CREATE UNIQUE INDEX repo_local_path_unique
  ON repo (local_path) WHERE local_path IS NOT NULL;
```

设计取舍：

- **不新增 `project` 表**：v0.1 单仓库单项目，`repo` 已经是远程身份的宿主；
  新增一层只会制造第二套命名。
- **不把 `last_synced_at` 写进 `repo`**：`repo` 对所有运行角色只读，把运行态写进去
  会破坏授权矩阵。同步证据写事件（见 §7）。
- **不新增 `sync_remote` 列**：v1 固定 `origin`。需要多 remote 时再加，避免为假设需求预留。
- **唯一索引建在 text 上**：数据库无法做 `realpath`，所以索引只能保证「规范化后的字符串不重复」；
  规范化是写入前提，由 §3.2 保证。`CHECK` 只拦住相对路径这类明显错误。

回滚：删除约束、索引与列即可；代码回滚后旧行为恢复。

## 3. 项目根与路径规范化

### 3.1 项目根

新增 `src/fact/project-root.ts`：

```ts
export function resolveKeelHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const abs = resolve(cwd, env.KEEL_HOME ?? '.keel')
  mkdirSync(abs, { recursive: true })
  return realpathSync(abs)   // 目录此时一定存在，realpath 不会抛 ENOENT
}
```

- **相对 `KEEL_HOME` 按进程启动时的 cwd 解析一次**，之后全链路只用返回的绝对路径。
  这样 `run-task` 与后续 worker 的 cwd 不同也不会指向两个项目根。
- `GitWorkspace` 的默认 root 从字面量 `'.keel'` 改为 `resolveKeelHome()`，
  修掉现有构造器对 cwd 的隐式依赖。
- 测试显式传 `root` 或设置 `KEEL_HOME`，两者都必须是绝对路径；
  测试用例之间不复用同一根。

### 3.2 `local_path` 规范化

绑定入口（`register-repo --local-path`）与运行入口（`prepareProject`）都走同一函数：

```ts
canonicalizeDir(input: string): Result<string>
// 1. resolve(cwd, input)         —— 消除相对路径
// 2. statSync(abs）必须是目录     —— 不存在直接报错
// 3. realpathSync(abs)           —— 消除符号链接、尾斜杠、..、重复分隔符
```

规则：

| 输入 | 规范化结果 | 说明 |
|---|---|---|
| `/repo` | `/repo` | 基准 |
| `/repo/` | `/repo` | 尾斜杠 |
| `/repo/./src/..` | `/repo` | 点段 |
| `../repo`（cwd=`/x`） | `/repo` | 相对路径 |
| `/link` → `/repo` | `/repo` | 符号链接 |
| `/repo//sub/..` | `/repo` | 重复分隔符 |

- **写入前规范化**：DB 里永远只有规范形式；唯一索引因此能真正挡住别名。
- **读取后再规范化**：`prepareProject` 对 DB 值再跑一次 `canonicalizeDir`，
  防住绕过 CLI 的写入与「绑定后目录被替换成符号链接」。失败即 fail-closed。
- **不自动修复**：目录不存在或不再是 git 工作树时，报错要求重新绑定，不猜新路径。

## 4. 绑定模式

| 模式 | `local_path` | git 目录 | worktree 根 |
|---|---|---|---|
| `managed` | `NULL` | `<KEEL_HOME>/repos/<repo_id>.git` | `<KEEL_HOME>/worktrees/<task_id>` |
| `attached` | 规范化后的用户目录 | `<local_path>` | `<KEEL_HOME>/worktrees/<task_id>` |

- **managed**：Keel 自己维护裸仓库。适合没有现成本地检出的场景。
- **attached**：以用户本地仓库为对象库，worktree 仍放在 `.keel` 下。
  好处是不需要第二份克隆；代价是 `ai/task-*` 分支会出现在用户仓库里（push 需要），
  且用户移动/删除目录会让绑定失效——这类情况一律 fail-closed，不猜路径。
- 用户工作树本身不被 checkout / pull / reset；attached 只把 `.git` 当对象库读写。

## 5. GitWorkspace 改造

现有 API 以「裸仓库路径」为中心；改为以「项目绑定」为中心：

```ts
type ProjectBinding =
  | { mode: 'managed'; repoId: string }
  | { mode: 'attached'; repoId: string; localPath: string }

interface PreparedProject {
  repoId: string
  gitDir: string        // 执行 `git -C` 的目录：managed 是 bare 仓库，attached 是用户工作树
  baseBranch: string
  baseRef: string       // 固定 refs/remotes/origin/<base>，仅供展示与追踪
  baseSha: string       // 本次基线的唯一锚点
  fetchedAt: string
}

prepareProject(binding, remoteUrl, baseBranch): Promise<Result<PreparedProject>>
ensureWorktree(project, taskId): Promise<Result<WorktreeInfo & { created: boolean }>>
headSha(project, taskId): Promise<Result<string>>
push(project, taskId, remoteUrl): Promise<Result<string>>
remove(project, taskId): Promise<Result<void>>
```

关键改动：

- `ensureBareRepo` 拆成 `ensureGitDir`（managed 才 clone）与 `syncBase`（两种模式都 fetch）。
- `ensureWorktree` 不再自己拼 `repos/<repoId>.git`，改用 `PreparedProject.gitDir`；
  **创建命令为 `git worktree add -b <branch> <wt> <baseSha>`**。
  用 40 位 commit 而不是 `baseRef`：prepare 与 worktree add 之间即使有另一个进程
  fetch 移动了 `origin/<base>`，新 worktree 的起点仍是证据里记录的那个 commit。
- `push` / `headSha` / `remove` 都改用 `gitDir`。
- `WorktreeInfo` 增加 `created: boolean`，供 §7 判断是否首次建分支。

### 5.1 原子初始化

`existsSync(bare)` 后再 clone 的写法会把「上次崩溃留下的半成品目录」当成可用仓库。
改为：

1. 目标存在 → 执行 `git -C <bare> rev-parse --is-bare-repository`，输出 `true` 才复用；
   否则返回 `[git_dir_invalid]`，提示人工确认后删除，**不自动删**（避免误删用户数据）。
2. 目标不存在 → clone 到 `<root>/repos/.tmp-<repoId>-<pid>`，成功后 `rename` 到目标；
   进程崩溃最多留下 `.tmp-*`，不污染正式路径。
3. clone / fetch / worktree add 全程持有 §5.2 的锁。

### 5.2 并发控制

不引入依赖，用**原子 `mkdir` 文件锁**：

```
<KEEL_HOME>/locks/repo-<repoId>.lock/
  owner.json   { pid, host, started_at, op }
```

```ts
withRepoLock<T>(root, repoId, op, fn): Promise<Result<T>>
```

- `mkdirSync(lockDir)` 成功即持锁；`EEXIST` 则每 50ms 重试。
- 默认等待 30s；超时返回 `[lock_timeout]`，附锁路径与建议命令。
- **不自动破锁**：锁内 `owner.json` 超过 10 分钟只作为诊断信息写进错误，
  不删除目录。自动破锁在慢进程 / 网络文件系统上会造成双重持锁。
- 粒度是 **per-repo**：同一 repo 的 clone、fetch、worktree add、remove 串行。
  代价是同一 repo 的多个 task 建 worktree 会排队（毫秒级），换取实现最小。
- **同进程不需要额外 mutex**：`mkdir` 在同一进程内同样互斥；并发调用在轮询中等待。
- **不嵌套**：`prepareProject` 与 `ensureWorktree` 各自取锁；
  锁内不再调用会取同一把锁的函数。

## 6. 同步语义

每次 run 的固定顺序：

```
1. 读 task + repo（local_path, remote_url, default_branch）
2. withRepoLock(repoId, 'prepare'):
   a. attached: canonicalizeDir(local_path) → 校验是 git 工作树、origin 与 remote_url 归一化一致
   b. managed: ensureGitDir（仅当缺失；原子 clone）
   c. git -C <gitDir> fetch --prune origin \
        +refs/heads/<base>:refs/remotes/origin/<base>
   d. baseSha = git -C <gitDir> rev-parse refs/remotes/origin/<base>
3. withRepoLock(repoId, 'worktree'):
   git -C <gitDir> worktree add -b ai/task-<id> <wt> <baseSha>   （仅当不存在）
4. 记录基线证据（§7）
```

为什么用显式 refspec 而不是 `git fetch origin <base>`：

- `git fetch origin <base>` 只保证 `FETCH_HEAD` 更新，是否更新 `origin/<base>`
  取决于 fetch refspec 配置，不够确定；
- 显式 `+refs/heads/<base>:refs/remotes/origin/<base>` 保证 `baseRef` 一定存在且最新。

为什么只 fetch base 而不是全部分支：

- 基线只需要一个分支；全量 fetch 在大仓库上是无谓成本。
- `--prune` 保留远端已删除分支的清理语义。

## 7. 基线证据

复用 `CreateBranch` 的 `SideEffectApplied` 事件，扩展 payload：

```json
{
  "kind": "CreateBranch",
  "dedupe_key": "ai/task-xxxxxxxx",
  "branch": "ai/task-xxxxxxxx",
  "worktree": "/.../.keel/worktrees/<task_id>",
  "base_ref": "refs/remotes/origin/main",
  "base_sha": "<40 hex>",
  "fetched_at": "2026-10-27T12:00:00.000Z",
  "reused": false
}
```

- **为什么不用新事件类型**：`event.type` 没有 CHECK 约束，加类型不需要迁移，但所有消费者
  （控制台分类、timeline、context builder）都要跟着改。`CreateBranch` 语义上就是
  「这条分支从哪里长出来」，把基线放这里最小。
- **重放**：`ensureWorktree` 返回 `created=false` 时，不再重新计算基线；读取该 task
  最近一条 `CreateBranch` 事件，复用其 `base_sha`，并标记 `"reused": true`。
  这样重放不会把旧分支的基线改写成今天的 `origin/<base>`。
- **无历史事件**（本改动之前创建的老 task）：`base_sha` 记为 `null`，不伪造。

## 8. 失败矩阵与错误契约

`KeelError.detail` 是字符串，本任务不扩展全局错误结构；改为在 `git-workspace.ts`
内部统一格式化，固定前缀 + 固定字段名，测试按前缀断言。

```ts
type WorkspaceFailureCode =
  | 'local_path_missing' | 'not_a_git_worktree' | 'origin_mismatch'
  | 'local_path_taken'   | 'git_dir_invalid'    | 'fetch_failed'
  | 'base_missing'       | 'lock_timeout'       | 'worktree_failed'
```

| 场景 | code | detail 形状 |
|---|---|---|
| 绑定目录不存在 | `local_path_missing` | `[local_path_missing] path="<abs>" hint="keel register-repo <url> --local-path <dir>"` |
| 不是 git 工作树 | `not_a_git_worktree` | `[not_a_git_worktree] path="<abs>"` |
| origin 不匹配 | `origin_mismatch` | `[origin_mismatch] expected="<norm>" actual="<norm>"` |
| 路径已被其他 repo 占用 | `local_path_taken` | `[local_path_taken] path="<abs>" repo="<id1>" occupied_by="<id2>"` |
| git 目录损坏 / 非 bare | `git_dir_invalid` | `[git_dir_invalid] path="<abs>" detail="<git stderr 摘要>"` |
| fetch 失败 | `fetch_failed` | `[fetch_failed] git_dir="<abs>" base="<base>" reason="<stderr 摘要>"` |
| 远端无该 base | `base_missing` | `[base_missing] remote="origin" base="<base>"` |
| 等锁超时 | `lock_timeout` | `[lock_timeout] lock="<path>" waited_ms=<n> holder="<pid>"` |
| 锁目录无法创建 | `lock_failed` | `[lock_failed] lock="<path>" op="<op>" detail="<摘要>"` |
| worktree 创建失败 | `worktree_failed` | `[worktree_failed] path="<wt>" branch="<branch>" reason="<摘要>"` |

- 所有 ErrorKind 仍是 `WORKSPACE_ERROR`，`RETRYABLE` 语义不变。
- `stderr` 摘要截断到 500 字符，不透出 token（凭据失败时 git 通常只给 URL 与状态码）。
- 每条 detail 必须能回答「下一步做什么」：重新绑定、检查网络/凭据、或删除损坏目录。

其余行为：

| 场景 | 行为 |
|---|---|
| 本地工作树有未提交改动 | 允许；不碰它，`keel status` 报 `dirty` |
| 本地 base 与 `origin/base` 分叉 | 允许；基线仍取 `origin/base`，`keel status` 报 `diverged` |
| worktree 已存在 | 幂等复用，`created=false`，不 rebase |
| 绑定目录被移动 / 删除 | run 前 `[local_path_missing]`，提示重新绑定 |

## 9. 兼容与迁移

### 9.1 绑定更新语义（已注册 repo）

`register-repo` 现有逻辑在命中已有 remote 时直接 `return row.id`，无法更新绑定。
改为一个事务内的显式语义：

```
1. 事务外：解析 remote、canonicalizeDir、git 校验（可能跑 git，不能占用事务）
2. 事务内（asOwner + FOR UPDATE 命中行）：
   - remote 不存在            → INSERT（带 local_path）
   - remote 存在 + 未传 flag  → 原样返回，不写库
   - remote 存在 + 传了 flag  → UPDATE repo SET local_path = $1 WHERE id = $2
3. 捕获唯一索引冲突 23505 → 回滚，反查占用者 id
   → [local_path_taken] path=... repo=<当前> occupied_by=<占用者>
4. 其他失败 → 原值不变（单语句 UPDATE 自身原子）
```

- **先校验后写入**：任何校验失败都发生在事务开始前，零写入。
- **同值更新是 no-op**：canonical 路径相同则不执行 UPDATE，避免无意义行版本变化。
- **已知限制**：`remote_url` 没有唯一索引，同一 remote 的并发 `register-repo`
  仍可能插入两行。这是既有问题，且 `register-repo` 是人工低频命令；
  本任务不顺手加索引（可能因存量数据重复导致迁移失败），记录为后续任务。

### 9.2 其余兼容

- 现有 repo 的 `local_path` 为空 → 自动进入 managed 模式。
- 行为变化：项目根从 `tmpdir()` 变为持久 `.keel`。依赖临时目录的测试需要改为
  设置 `KEEL_HOME` 到测试临时目录。
- `register-repo` 的现有调用方式保持可用；`--local-path` 为可选参数。
- 不做数据回填。
- 回滚：代码回滚 + 保留列（无害）；必要时 down migration 删除约束、列与索引。

## 10. 备选方案与取舍

| 方案 | 结论 |
|---|---|
| 新增 `project` 表 | 拒绝：v0.1 单项目，和 `repo` 重复 |
| Keel 直接在用户工作树里执行 | 拒绝：破坏 N1/S1，脏状态与「谁改的」归因混乱 |
| 每次 run 前 `git pull` 用户分支 | 拒绝：修改用户工作树，冲突不可控 |
| 始终维护 `.keel` 下的 bare 镜像 | 可行，但多一份磁盘与同步层；attached 直接用对象库更省 |
| 新事件 `WorkspacePrepared` | 更清晰，但要改所有消费者；先用 `CreateBranch` payload |
| 把同步信息写进 `repo` 表 | 拒绝：破坏 repo 只读矩阵，且运行态会变成第二事实源 |
| 引入 `proper-lockfile` 等依赖 | 拒绝：`mkdir` 原子锁足够，不为此加依赖 |
| 自动清理陈旧锁 | 拒绝：慢进程 / NFS 下会双重持锁；改为报告锁路径 |
| worktree 用 `baseRef` 创建 | 拒绝：prepare 与 add 之间 ref 可能移动，证据与实际起点不一致 |

## 11. 测试策略

- **单元**：URL 归一化、目录规范化（§3.2 六种别名）、refspec 组装、
  `base_sha` 解析、错误 detail 前缀与字段、replay 幂等。
- **集成**：managed / attached 两种模式；远端前进后新 worktree 的起点；
  用户工作树在 run 前后完全不变；`run-issue --ci real` 回归。
- **绑定更新**：无 flag 保留；managed → attached；attached → 新路径；
  同路径第二 repo 报错含两个 id；校验失败时原值不变。
- **并发**（`Promise.all`，真实 git + 真实文件锁）：
  1. 首次 `prepareProject` 两次并发 → 只发生一次 clone，无半成品目录；
  2. 两次并发 fetch → 串行完成，无 `index.lock` / `cannot lock ref` 错误；
  3. 同 task 并发 `ensureWorktree` → 只创建一个 worktree，另一个 `created=false`；
  4. 锁被占用超过超时 → `[lock_timeout]`，不写任何状态。
- **orchestrator 接线**：`loop.ts` 的 `resolveWorkspace` 与 `headSha` 走新 API；
  `ci-wiring.test.ts` 的 worktree fixture 更新后仍能读到正确 head SHA。
- **负对照**：目录不存在、remote 不匹配、远端不可达、base 不存在、本地分叉、
  `local_path` 被替换成别名、去掉锁后并发用例变红。
- git 测试一律用 `file://` 临时仓库，不 mock git；每个用例独立 `KEEL_HOME`。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| attached 模式下 `ai/*` 分支出现在用户仓库 | 文档说明；终态后可选择保留（审计）或清理（后续） |
| 用户与 Keel 同时操作同一对象库 | per-repo 锁 + worktree 隔离 + fail-closed |
| 大仓库 fetch 成本 | 只 fetch base + `--prune` |
| 绑定目录被移动 | 明确报错，要求重新绑定，不猜测新路径 |
| 锁目录残留 | 超时错误给出路径与持有者信息；不自动删除 |
| 凭据差异：attached 用用户 git 凭据，managed 用现有方式 | 本任务不改凭据；在 R4.5 回归中覆盖 |
| 同 remote 并发注册产生重复行 | 既有问题，记录为后续任务（§9.1） |
