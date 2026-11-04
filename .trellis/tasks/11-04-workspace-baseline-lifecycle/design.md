# 工作区基线与生命周期：技术设计

> 对应 `prd.md` R1–R7。代码位置以 2026-11-04 的 `main` 为准。
> 本设计只解决「事实与磁盘不一致」这一类问题，不顺手重构工作区模型。

## 1. 不变量

- **I1 事实优先**：事件流只能记录真实发生的事。没落地就写 `SideEffectIntent`，
  不写 `SideEffectApplied`。
- **I2 基线是 SHA**：`CreateBranch` 的 `base_sha` 描述分支真正的起点，
  不是「本次 prepare 时 origin/main 在哪」。
- **I3 终态不可回滚**：S-DONE / S-REJECTED 一旦成立，清理失败不能把它改回去。
- **I4 不删可能含未提交内容的目录**：路径异常时 fail closed，交给人判断。
- **I5 不新增迁移 / 依赖**：本任务只改代码与文档。
- **I6 锁只由人破**：`mkdir` 锁没有原子的 compare-and-delete，
  自动破锁会引入双重持锁窗口。

## 2. P0-3 项目根与 blob 根

### 2.1 现状与问题

`src/fact/project-root.ts:31`：

```ts
const abs = resolve(cwd, env.KEEL_HOME ?? '.keel')
```

默认 `.keel` 永远相对当前 cwd。从项目根启动一次、从 `src/` 启动一次，
会得到两个项目根：裸仓库、worktree、锁全部对不上。

`src/fact/blob.ts:34` 又独立地用 `process.env.KEEL_BLOB_DIR ?? '.keel/blob'`，
即使 `KEEL_HOME` 指到别处，blob 还是落在 cwd 下。大产物写成引用后，
换目录读不回来。

### 2.2 目标算法

```ts
export function resolveKeelHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.KEEL_HOME
  if (explicit !== undefined && explicit !== '') {
    return ensureDir(resolve(cwd, explicit))
  }
  return ensureDir(findProjectHome(cwd))
}

function findProjectHome(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    const keel = join(dir, '.keel')
    if (isDirectory(keel)) return keel
    // 只认目录形态的 .git：worktree / submodule 的 .git 是文件，继续向上找
    if (isDirectory(join(dir, '.git'))) return keel
    const parent = dirname(dir)
    if (parent === dir) return join(start, '.keel')
    dir = parent
  }
}

function ensureDir(abs: string): string {
  mkdirSync(abs, { recursive: true })
  return realpathSync(abs)
}
```

规则顺序：

1. **显式 `KEEL_HOME`**：最高优先级，按 cwd 解析（与现状一致）。
2. **最近的已有 `.keel`**：嵌套工作台 / 子项目优先于外层项目根。
3. **最近的 `.git` 目录**：作为项目根，`<root>/.keel` 由 `ensureDir` 创建。
4. **都没有**：退回 `<cwd>/.keel`，与今天的行为一致。

### 2.3 为什么 `.git` 只认目录

`git worktree` 与 submodule 的 `.git` 是**文件**。如果把它当项目根，
从 Keel 自己的 worktree（`<KEEL_HOME>/worktrees/<taskId>/`）里启动 keel，
会得到 `<worktree>/.keel` 这个第三个根。继续向上找会经过 `<KEEL_HOME>`，
最终在真正的项目根命中 `.keel` 或 `.git`。

### 2.4 blob 根

```ts
export function blobRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env.KEEL_BLOB_DIR
  if (override !== undefined && override !== '') return override
  return join(resolveKeelHome(env, cwd), 'blob')
}
```

- 显式 `KEEL_BLOB_DIR` 语义不变：相对值仍相对 cwd，由部署方自己保证一致。
- 默认值改为跟随 `KEEL_HOME`，与 `repos/`、`worktrees/`、`locks/` 同根。
- `blobRoot` 增加可选参数只为测试注入；生产调用 `blobRoot()` 不变。

### 2.5 边界

- 项目树外启动仍需显式 `KEEL_HOME`。不引入全局注册表 / 数据库映射：
  那会多一个必须跨机器一致的状态，且无法在仓库自包含。
- 没有 `.git` 的目录（例如导出的源码包）仍退回 `<cwd>/.keel`，
  与今天相同；这类场景本来就没有稳定的「项目根」定义。
- `resolveKeelHome` 会 `mkdir`（现有行为）。从子目录启动第一次会在项目根
  创建 `.keel`，这是预期副作用。

### 2.6 测试

`src/fact/project-root.test.ts`：

- 显式 `KEEL_HOME` 仍按给定 cwd 解析（保留现有用例，标题点明「显式」）。
- 嵌套目录向上命中父级 `.keel`。
- 沙箱根有 `.git` 目录、无 `.keel` → `<sandbox>/.keel`。
- 子目录的 `.git` 是**文件**（模拟 worktree）→ 继续向上命中父级 `.keel`。
- 符号链接根仍收敛到真实路径。

新增 `src/fact/blob.test.ts`：

- `KEEL_BLOB_DIR` 设置时原样返回。
- 未设置时返回 `<resolveKeelHome()>/blob`；从子目录调用与从根调用一致。

## 3. P0-1 + P1-6 worktree 生命周期

### 3.1 现状

`src/fact/git-workspace.ts:176` 的 `ensureWorktree`：

```ts
if (existsSync(wt)) return ok({ ...info, created: false })
...
const exists = await this.branchExists(project.gitDir, branch)
const args = exists
  ? ['worktree', 'add', wt, branch]
  : ['worktree', 'add', '-b', branch, wt, project.baseSha]
await this.execGit(['-C', project.gitDir, ...args])
return ok({ ...info, created: true })
```

两个缺陷：

1. `created` 同时表示「worktree 新建」和「分支新建」。worktree 被删、
   分支还在时，分支其实是旧的，但 `createBranch` 会把它当新分支记证据。
2. `existsSync` 为真就直接复用，不验证它是不是 worktree、是不是在期望分支；
   `existsSync` 为假时直接 `add`，不 `prune` 陈旧注册，任务会永久卡住。

### 3.2 `WorktreeResult` 增加 `branchCreated`

```ts
export interface WorktreeResult extends WorktreeInfo {
  /** 本次调用是否真的创建了 worktree；false 表示幂等复用 */
  readonly created: boolean
  /** 本次调用是否真的创建了分支；false 表示复用了已有分支 */
  readonly branchCreated: boolean
}
```

保留 `created`：它仍被并发测试与日志使用；新增字段只把两个语义拆开。

### 3.3 `ensureWorktree` 状态机

| 磁盘 | 分支 | 动作 | `created` | `branchCreated` |
|---|---|---|---|---|
| 路径存在，是 worktree 且分支匹配 | 有 | 复用 | `false` | `false` |
| 路径存在，不是 worktree 根 | — | fail closed | — | — |
| 路径存在，分支不匹配 | 有 | fail closed | — | — |
| 路径不存在，分支存在 | 有 | `worktree add <wt> <branch>`；失败 → `prune` → 重试一次 | `true` | `false` |
| 路径不存在，分支不存在 | 无 | `worktree add -b <branch> <wt> <baseSha>`；失败 → `prune` → 重试一次 | `true` | `true` |

### 3.4 校验已有目录

```ts
private async inspectWorktree(
  wt: string,
  branch: string,
): Promise<Result<{ actual: string }>> {
  if (!existsSync(join(wt, '.git'))) {
    return err(workspaceError('worktree_failed', {
      path: wt,
      branch,
      reason: '目录存在但不是 worktree 根（缺少 .git）',
    }))
  }
  try {
    const { stdout } = await this.execGit(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const actual = stdout.trim()
    if (actual !== branch) {
      return err(workspaceError('worktree_failed', {
        path: wt,
        branch,
        reason: `期望分支 ${branch}，实际 ${actual}`,
      }))
    }
    return ok({ actual })
  } catch (e) {
    return err(workspaceError('worktree_failed', { path: wt, branch, reason: this.redact(e) }))
  }
}
```

为什么先看 `.git`：路径可能在父仓库内部，`git -C <普通子目录> rev-parse`
会命中父仓库，看起来「有效」；`.git` 存在才说明它自己是 worktree 根。

为什么 fail closed：这个目录是 Keel 管理的，但可能有上一次崩溃留下的未提交内容。
删掉再建会把它们静默丢掉；返回错误让人先看。

### 3.5 陈旧注册的恢复

```ts
try {
  await add(exists)
} catch {
  // worktree 目录被外部删除后，git 仍保留注册；prune 清掉再重试一次。
  await this.execGit(['-C', project.gitDir, 'worktree', 'prune']).catch(() => undefined)
  try {
    await add(exists)
  } catch (e2) {
    return err(workspaceError('worktree_failed', { path: wt, branch, reason: this.redact(e2) }))
  }
}
```

- 只在 `add` 失败后 prune：attached 模式下不主动改用户仓库的 worktree 元数据。
- 只重试一次：真实错误（base SHA 不存在、权限不足）第二次仍会失败，
  不会变成无限循环。
- `prune` 失败不掩盖：忽略 prune 自己的错误，让第二次 `add` 的失败成为最终错误。

### 3.6 `createBranch` 的证据选择

`src/control/driver/effects.ts:402` 改为按 `branchCreated` 判断：

```ts
const evidence = wt.value.branchCreated
  ? { base_ref: project.baseRef, base_sha: project.baseSha, fetched_at: project.fetchedAt }
  : await baselineOfExistingBranch(c, ctx.taskId, project)

await emit(c, ctx, 'SideEffectApplied', {
  kind: 'CreateBranch',
  dedupe_key: wt.value.branch,
  branch: wt.value.branch,
  worktree: wt.value.path,
  ...evidence,
  reused: !wt.value.branchCreated,
}, ctx.now)
```

- 首次建分支：`branchCreated=true`，证据来自本次 prepare，`reused=false`。
- 复用分支（含 worktree 被删后重建）：`branchCreated=false`，
  读最近一条 `CreateBranch` 事件，`reused=true`。
- 没有历史事件：`baselineOfExistingBranch` 返回 `base_sha: null`，
  保持「不编造」的既有契约。
- **不修复历史错误证据**：如果旧版本已经写入了错误 `base_sha`，新代码无法
  分辨它是否是真的；本任务只保证今后不再产生新的错误。需要修正历史时另开
  数据修复任务。

### 3.7 `remove` 的错误契约

`src/fact/git-workspace.ts:300` 目前只在主路径返回 `Result`；fallback 里的
`rm` 抛异常会直接 reject。改为：

```ts
async remove(project: PreparedProject, taskId: string): Promise<Result<void>> {
  return this.withRepoLock(project.repoId, 'remove', async () => {
    const wt = this.worktreePath(taskId)
    if (!existsSync(wt)) return ok(undefined)
    try {
      await this.execGit(['-C', project.gitDir, 'worktree', 'remove', '--force', wt])
      return ok(undefined)
    } catch {
      try {
        await rm(wt, { recursive: true, force: true })
        await this.execGit(['-C', project.gitDir, 'worktree', 'prune']).catch(() => undefined)
        return ok(undefined)
      } catch (e) {
        return err(workspaceError('worktree_failed', { path: wt, reason: this.redact(e) }))
      }
    }
  })
}
```

### 3.8 测试

`src/fact/git-workspace.test.ts`：

- 首次创建：`created=true`、`branchCreated=true`、HEAD=baseSha。
- 重复调用：`created=false`、`branchCreated=false`、分支不移动。
- 删除 worktree 目录后再次调用：`created=true`、`branchCreated=false`，
  HEAD 仍是分支原 tip（不是本次 baseSha）。
- 路径被普通目录占用：返回 `worktree_failed`，目录仍在。
- 路径是另一个分支的 worktree：返回 `worktree_failed`，含期望 / 实际分支。
- 并发调用仍只有一个 `created=true`（现有断言保留）。

`src/control/driver/effects.test.ts`：

- 删除 worktree 后重放 `CreateBranch`：`base_sha` 等于首次事件，`reused=true`。
- 首次 `CreateBranch`：`reused=false`，`base_sha` 是 40 位 commit。

## 4. P0-2 CI 来源

### 4.1 类型

`src/control/transition/types.ts:36`：

```ts
export type CiSource = 'simulated' | 'github'

| { readonly type: 'CIPassed'; readonly source: CiSource }
| { readonly type: 'CIFailed'; readonly source: CiSource }
```

`source` 设为**必填**：可选字段会让「忘了标来源」重新变成合法状态，
这正是本次要消灭的歧义。所有调用点与测试一次性改完。

### 4.2 `TaskStatusChanged` payload

`src/control/driver/driver.ts:338`：

```ts
const isCi = event.type === 'CIPassed' || event.type === 'CIFailed'
const payload = {
  from: result.from,
  to: result.next_status,
  transition: result.id,
  event: event.type,
  ...(isCi ? { source: event.source } : {}),
}
```

- 非 CI 事件不出现 `source` 键，payload 形状保持最小。
- `docs/schemas/event.schema.json` 的 `payload` 是开放对象，不需要重新生成类型。
- 旧事件没有 `source`：读取方把它当 `unknown`，不回填、不猜测。

### 4.3 编排循环的两个来源

`src/control/orchestrator/loop.ts:215` 有两条路径：

| 路径 | 条件 | `source` | step note |
|---|---|---|---|
| 真实网关 | `opts.ci !== undefined`（`--ci real`） | `github` | `外部 CI（GitHub）：passed` |
| 注入回调 | `opts.externalCi !== undefined`（`--ci passed/failed`） | `simulated` | `外部 CI（模拟）：passed` |

来源由**实际走的路径**决定，不由 `--ci` 字符串决定：
`--ci real` 缺 token 时在进入 loop 前就失败，不会走到回调。

### 4.4 测试

- `driver.test.ts`：`CIPassed` 的 payload 含 `source`。
- `ci-wiring.test.ts`：真实网关路径断言 `source=github`。
- 模拟路径（`externalCi`）断言 `source=simulated`；若现有测试不覆盖，
  在 `loop` 的 CI 测试里补一条。
- 更新断言 `外部 CI：passed` 的两处测试（`ci-wiring.test.ts`、
  `v01-criterion-github.acceptance.test.ts`）。

## 5. P1-4 + P1-5 终态清理

### 5.1 转移表

`src/control/transition/table.ts:217` / `:314`：

```ts
// T-015
effects: [{ kind: 'CleanWorkspace' }]

// T-024
effects: [{ kind: 'MaybeAutoMerge' }, { kind: 'CleanWorkspace' }]
```

- 顺序：先 merge，后清理。`MaybeAutoMerge` 目前只记意图；将来真实现时，
  如果 merge 失败并抛错，事务回滚，清理不会执行，现场仍在。
- `T-006` 保持 `[]`：PM 驳回时还没有 worktree。
- `T-020` / `T-023` / `T-026` 保持不清理：升人工的任务需要现场供人看。
- `T-027` / `T-040` 不变；`T-041` 继续 `PreserveWorkspace`。

### 5.2 `cleanWorkspace` 如实记账

`src/control/driver/effects.ts:455`：

```ts
async function cleanWorkspace(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  if (ctx.workspace === undefined) return recordIntent(c, ctx, { kind: 'CleanWorkspace' })

  const removed = await ctx.workspace.git.remove(ctx.workspace.project, ctx.taskId)
  if (!removed.ok) {
    await emit(c, ctx, 'SideEffectIntent', {
      kind: 'CleanWorkspace',
      dedupe_key: ctx.taskId,
      reason: removed.error.detail,
    }, ctx.now)
    return {
      kind: 'CleanWorkspace',
      outcome: 'intent',
      detail: `清理失败：${removed.error.detail}`,
    }
  }

  await emit(c, ctx, 'SideEffectApplied', {
    kind: 'CleanWorkspace',
    dedupe_key: ctx.taskId,
  }, ctx.now)
  return { kind: 'CleanWorkspace', outcome: 'applied', detail: '已移除 worktree' }
}
```

- **不抛错**：S-DONE 的「CI 通过」已经成立，清理失败是副作用失败，不是状态失败。
  抛错会让整个转移回滚，把任务从 S-DONE 拉回去，反而制造更不真实的事实。
- 用现有 `SideEffectIntent`，不新增事件类型：它的语义正是「记了意图、没落地」。
- 失败原因进 `reason`，`keel status` 的事件流可以直接看到。

### 5.3 文档同步

- `docs/04-state-machine.md:100` T-015 效果列改为「清理工作区」。
- `docs/04-state-machine.md:109` T-024 效果列改为「按配置可自动 merge；清理工作区」。
- `.trellis/spec/backend/transition-effects.md` 的人工闸门表：
  `reject` 的副作用从「无副作用」改为「清理工作区（分支保留）」。
- C4 检查只比对 id / from / to / guardText，不比对 effects；文档改动仍需人工
  对照，防止「代码改了、文档没改」。

### 5.4 测试

- `transition.test.ts`：T-015 / T-024 的 effects 含 `CleanWorkspace`。
- `effects.test.ts`：
  - 成功：真实 `GitWorkspace` + 已建 worktree → 调用 `CleanWorkspace` 后目录消失，
    `git branch --list <branch>` 仍能看到分支。
  - 失败：注入 `remove` 返回 `err(workspaceError('worktree_failed', ...))` →
    事件流出现 `SideEffectIntent`，没有 `SideEffectApplied`，函数不抛。
- `driver.test.ts`：S-PR_OPEN + `CIPassed`（`source: 'simulated'`）→ S-DONE，
  且 worktree 目录消失（注入真实 workspace 时）。

## 6. P1-7 解锁入口

### 6.1 为什么不做自动破锁

`mkdir` 锁的持有判断与删除不是原子的：

1. A 读到 `owner.json` 是死进程；
2. B 也读到，删掉锁并重新 `mkdir` 成功；
3. A 再删一次，删掉的是 B 的锁。

要消除这个窗口，需要 `flock` / 租约 / 带 CAS 的存储，都会引入新依赖或新状态。
现有 spec 已经明确「不自动破锁」；本任务提供一个**显式**入口，保持这条不变量。

### 6.2 `keel unlock`

新增 `src/cli/unlock.ts`：

```ts
export interface UnlockOptions {
  readonly root?: string
  readonly force?: boolean
}
export interface UnlockOutcome {
  readonly lockDir: string
  readonly removed: boolean
  readonly holder: string | null
}
export async function unlockRepo(
  repoId: string,
  opts: UnlockOptions = {},
): Promise<Result<UnlockOutcome>>
```

行为：

| 条件 | 结果 |
|---|---|
| `repoId` 不匹配 `/^[A-Za-z0-9._-]+$/` | `CAPABILITY_UNSUPPORTED`（防路径穿越） |
| 锁目录不存在 | `ok({ removed: false, holder: null })` |
| 锁存在，无 `--force` | `CONFLICT`，打印持有者与 `--force` 用法 |
| 锁存在，有 `--force` | 删除锁目录；返回 `removed: true` + 原持有者 |

`root` 用 `resolveKeelHome()`，因此 P0-3 修好后，在项目树内任意目录执行
都会命中同一把锁。

`src/cli/run.ts` 增加 `unlock` 分发与 HELP 行；`unlock` 不碰数据库，
`runCli` 的 `closePool` 仍然会在 finally 里执行（未初始化时是 no-op）。

### 6.3 `lock_timeout` 的可操作提示

`FileLockOptions` 增加：

```ts
/** 超时错误里附带的可操作提示，例如 unlock 命令 */
readonly hint?: string
```

`lock_timeout` 的字段增加 `hint`：

```ts
workspaceError('lock_timeout', {
  lock: lockDir,
  op,
  waited_ms: waited,
  holder: describeHolder(lockDir, staleMs, now),
  hint: opts.hint,
})
```

`GitWorkspace.withRepoLock` 传入
`hint: \`pnpm keel unlock ${repoId} --force\``。`workspaceError` 已经会跳过
`undefined` 字段，不需要改格式化逻辑；spec 的字段表补一行。

### 6.4 测试

新增 `src/cli/unlock.test.ts`：

- 锁不存在 → `removed:false`。
- 锁存在、无 `--force` → `CONFLICT`，锁仍在，错误文本含持有者。
- 锁存在、有 `--force` → 删除，返回原持有者。
- `repoId` 含 `/` 或 `..` → 拒绝，且不触碰文件系统。

`src/fact/file-lock.test.ts`：

- 传入 `hint` 时，`lock_timeout` 的 detail 含该提示。
- 现有「不自动破锁」用例保留：锁目录与 `owner.json` 仍在。

## 7. 兼容性、发布与回滚

### 7.1 兼容性

- **无数据库迁移**：所有改动都在代码 / 文档层。
- **无生成类型变更**：`event.schema.json` 的 payload 是开放对象。
- **旧事件**：没有 `source` 的 CI 事件按 `unknown` 读取；没有 `branchCreated`
  字段是运行时值，不落库；旧 `CreateBranch` 的 `base_sha` 原样保留。
- **旧数据**：历史错误证据不自动修复（见 3.6）。
- **CLI**：`run-task` / `run-issue` 的 `--ci` 缺省值不变；新增 `unlock` 子命令，
  不影响已有命令。

### 7.2 发布顺序

1. P0-3（根解析）：后续所有路径相关测试都在新语义下跑。
2. P0-1 + P1-6（worktree）：依赖根解析稳定。
3. P0-2（CI 来源）：独立。
4. P1-4 + P1-5（终态清理）：依赖 `remove` 的错误契约。
5. P1-7（unlock）：依赖根解析稳定。

### 7.3 回滚

- 每项都是独立代码改动，按相反顺序 revert 即可。
- 回滚 P1-4 只会让终态重新留下 worktree（安全）。
- 回滚 P0-3 会恢复 cwd 相对行为；已经在新根下创建的 `.keel` 不会被删除，
  需要人工确认后再迁移 / 清理。
- 回滚 P1-7 不会影响锁本身；已存在的锁仍需手工删除。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 向上查找命中意料之外的父级 `.keel` | 显式 `KEEL_HOME` 最高优先级；`.git` 目录作为项目边界；测试覆盖嵌套 / worktree |
| S-DONE 清理后无法立刻看现场 | 分支与 PR 保留，worktree 可从分支重建；S-FAILED 仍保留现场；文档写明 |
| `prune` 误删临时不可达的 worktree 注册 | 只在 `add` 失败后 prune；分支仍在，可重新 add；全程持 repo 锁 |
| `unlock --force` 与正在运行的操作并发 | 必须显式 `--force`；先打印持有者；文档写明风险 |
| CI `source` 必填导致测试大面积改 | 调用点只有 loop 两处 + 少量测试；一次性改完，类型检查兜底 |
| `remove` 失败被当成状态失败 | `cleanWorkspace` 不抛错，只写 `SideEffectIntent`；测试钉住 |

## 9. 测试矩阵

| 需求 | 测试文件 | 关键断言 |
|---|---|---|
| R1 基线证据 | `src/control/driver/effects.test.ts` | 删除 worktree 后重放，`base_sha` 沿用首次值，`reused=true` |
| R1 分支新建标志 | `src/fact/git-workspace.test.ts` | 首次 `branchCreated=true`；重复 / 重建 `false` |
| R2 CI 来源 | `src/control/driver/driver.test.ts`、`src/control/orchestrator/ci-wiring.test.ts` | payload `source` 为 `github` / `simulated` |
| R2 缺省不变 | `src/cli/run-task.test.ts`（现有） | 无 `--ci` 仍走模拟路径 |
| R3 根解析 | `src/fact/project-root.test.ts` | 子目录命中父级 `.keel`；`.git` 文件继续向上 |
| R3 blob 根 | `src/fact/blob.test.ts` | 默认落在 `<KEEL_HOME>/blob` |
| R4 终态清理 | `src/control/transition/transition.test.ts`、`effects.test.ts` | T-015 / T-024 effects 含 `CleanWorkspace`；目录消失、分支保留 |
| R5 清理失败 | `src/control/driver/effects.test.ts` | `SideEffectIntent`、无 `SideEffectApplied`、不抛 |
| R6 worktree 恢复 | `src/fact/git-workspace.test.ts` | 删除目录后重建成功；普通目录 fail closed |
| R7 解锁 | `src/cli/unlock.test.ts`、`src/fact/file-lock.test.ts` | 无 `--force` 拒绝；有 `--force` 删除；timeout 含 hint |
| 全量 | `pnpm run check` | lint / typecheck / boundaries / generated / transitions / purity / test |
