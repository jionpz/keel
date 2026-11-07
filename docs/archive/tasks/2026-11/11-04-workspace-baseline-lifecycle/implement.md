# 实施计划：工作区基线与生命周期（P0+P1）

> 对应 `prd.md` R1–R7、`design.md` §2–§6。
> 每个阶段都按「改代码 → 跑定向测试 → review diff → 进入下一阶段」推进；
> 全部完成后跑一次 `pnpm run check`，再进入 Trellis Phase 3 的 spec 更新与提交。

## 0. 准备与基线

- 确认测试库可用：`KEEL_DATABASE_URL` 缺省 `postgres://localhost/keel_test`。
  `vitest.globalSetup.ts` 会先跑迁移；连不上会直接失败，不跳过。
- 先跑一次基线，记录改动前是否已经存在失败：

```bash
pnpm run check
```

- 读一遍本任务要遵守的 spec：
  - `.trellis/spec/backend/git-workspace.md`
  - `.trellis/spec/backend/transition-effects.md`
  - `.trellis/spec/backend/orchestrator-loop.md`
  - `.trellis/spec/backend/error-handling.md`
  - `.trellis/spec/backend/cli-lifecycle.md`
- 确认当前分支 / worktree 是 `task.py start` 创建的那一个；不要直接改 `main`。

**阶段出口**：基线命令的结果已知；后续任何新失败都能归因到本次改动。

---

## 1. P0-3：项目根与 blob 根

### 改动

- `src/fact/project-root.ts`
  - `resolveKeelHome`：显式 `KEEL_HOME` 优先；否则 `findProjectHome(cwd)`。
  - 新增 `findProjectHome` / `isDirectory` / `ensureDir`（内部函数）。
  - `.keel` 先于 `.git`；`.git` 只认目录；到文件系统根后回退 `<cwd>/.keel`。
- `src/fact/blob.ts`
  - `blobRoot(env, cwd)`：显式 `KEEL_BLOB_DIR` 优先；否则
    `join(resolveKeelHome(env, cwd), 'blob')`。
- `src/fact/project-root.test.ts`
  - 保留显式 `KEEL_HOME` 用例，标题点明「显式」。
  - 新增：嵌套目录命中父级 `.keel`；`.git` 目录作为项目根；`.git` 文件继续向上；
    符号链接仍收敛。
- 新增 `src/fact/blob.test.ts`
  - 覆盖显式 override 与默认 `<KEEL_HOME>/blob`。
- `README.md:110-111`
  - 把「默认 `<当前目录>/.keel`」改成「从 cwd 向上找最近的 `.keel` 或项目根；
    项目树外请显式设置 `KEEL_HOME`」。

### 验证

```bash
pnpm vitest run src/fact/project-root.test.ts src/fact/blob.test.ts
pnpm run typecheck
```

### Review 重点

- 测试只在自己创建的临时目录里写文件，不碰仓库根的真实 `.keel`。
- `artifact-store.test.ts` 的 `afterAll` 删除 `blobRoot()`；确认在 vitest cwd 下
  解析结果与改动前一致（都是仓库根的 `.keel/blob`），不会误删别处。
- 不再有 `process.cwd()` 直接拼 `.keel/blob` 的路径。

### 回滚点

只回滚本阶段 4 个文件；后续阶段尚未开始。

---

## 2. P0-1 + P1-6：worktree 生命周期

### 改动

- `src/fact/git-workspace.ts`
  - `WorktreeResult` 增加 `branchCreated: boolean`。
  - `ensureWorktree`：
    - `existsSync(wt)` → `inspectWorktree(wt, branch)`；无效则返回
      `workspaceError('worktree_failed', ...)`，不删目录。
    - 路径不存在 → 解析 `exists`，`add` 失败后 `worktree prune` 再重试一次。
    - 返回 `created` 与 `branchCreated` 两个标志。
  - 新增私有 `inspectWorktree`（`.git` 存在 + `rev-parse --abbrev-ref HEAD` 匹配）。
  - `remove`：fallback `rm` 包 try/catch，失败返回 `Result`，不抛异常。
- `src/control/driver/effects.ts`
  - `createBranch`：用 `branchCreated` 选择证据；`reused: !branchCreated`。
- `src/fact/git-workspace.test.ts`
  - 首次 / 重复 / 删除后重建 / 普通目录占用 / 错误分支 / 并发唯一创建。
- `src/control/driver/effects.test.ts`
  - 删除 worktree 后重放 `CreateBranch`，`base_sha` 沿用首次值。

### 验证

```bash
pnpm vitest run src/fact/git-workspace.test.ts src/control/driver/effects.test.ts
pnpm run typecheck
```

### Review 重点

- 现有并发测试仍然通过：两个并发调用只有一个 `created=true`。
- `inspectWorktree` 对「父仓库内的普通子目录」也返回错误（`.git` 不存在）。
- 删除后重建的场景，HEAD 必须是分支原 tip，不是本次 `prepareProject.baseSha`。
- `remove` 的所有失败路径都返回 `Result`，没有裸 `throw`。

### 回滚点

回滚本阶段文件即可；`WorktreeResult` 的新字段是增量，旧调用方不受影响。

---

## 3. P0-2：CI 来源

### 改动

- `src/control/transition/types.ts`
  - 新增 `CiSource`；`CIPassed` / `CIFailed` 增加必填 `source`。
- `src/control/driver/driver.ts`
  - `TaskStatusChanged` payload 对 CI 事件加 `source`。
- `src/control/orchestrator/loop.ts`
  - 真实网关：`source: 'github'`，note `外部 CI（GitHub）：...`。
  - 注入回调：`source: 'simulated'`，note `外部 CI（模拟）：...`。
- 测试与调用点：
  - `src/control/transition/transition.test.ts`
  - `src/control/driver/driver.test.ts`
  - `src/control/orchestrator/ci-wiring.test.ts`
  - `src/acceptance/v01-criterion-github.acceptance.test.ts`（只改断言文本）

### 验证

```bash
pnpm run typecheck
pnpm vitest run src/control/transition src/control/driver src/control/orchestrator
```

再全局搜一次，确认没有漏掉的 CI 事件构造：

```bash
grep -rn "type: 'CIPassed'\|type: 'CIFailed'" src --include="*.ts"
```

### Review 重点

- 每个构造点都带 `source`；没有 `source: undefined` 的兼容分支。
- `TaskStatusChanged.payload` 的非 CI 事件没有多出 `source` 键。
- 真实 / 模拟两条路径的 note 与 payload 来源一致。
- CLI 缺省值未改：`run-task.ts:270`、`run-issue.ts:151` 仍是 `passed`。

### 回滚点

回滚本阶段文件；旧事件缺少 `source` 不影响读取。

---

## 4. P1-4 + P1-5：终态清理与失败记账

### 改动

- `src/control/transition/table.ts`
  - T-015：`effects: [{ kind: 'CleanWorkspace' }]`。
  - T-024：`effects: [{ kind: 'MaybeAutoMerge' }, { kind: 'CleanWorkspace' }]`。
- `src/control/driver/effects.ts`
  - `cleanWorkspace` 检查 `remove` 的 Result；失败写 `SideEffectIntent`
    并返回 `outcome: 'intent'`，不抛错。
- `src/control/transition/transition.test.ts`
  - 断言 T-015 / T-024 的 effects。
- `src/control/driver/effects.test.ts`
  - 成功：worktree 目录消失，分支仍在。
  - 失败：`SideEffectIntent`、无 `SideEffectApplied`、不抛。
- `docs/04-state-machine.md`
  - T-015 效果列：「清理工作区」。
  - T-024 效果列：「按配置可自动 merge；清理工作区」。
- `.trellis/spec/backend/transition-effects.md`
  - `reject` 行的副作用改为「清理工作区（分支保留）」。

### 验证

```bash
pnpm run check:transitions
pnpm vitest run src/control/transition src/control/driver
```

### Review 重点

- C4 只比对 id / from / to / guardText，effects 不会自动比对；文档列要人工确认。
- `cleanWorkspace` 失败时，`TaskStatusChanged` 仍然写入，任务仍是 S-DONE / S-REJECTED。
- `remove` 失败的错误 detail 进了 `SideEffectIntent.payload.reason`，没有丢。
- T-041 仍是 `PreserveWorkspace`，没有被误加清理。

### 回滚点

回滚本阶段文件；终态会重新留下 worktree，但不会破坏已有分支 / PR。

---

## 5. P1-7：`keel unlock`

### 改动

- `src/fact/file-lock.ts`
  - `FileLockOptions` 增加 `hint?: string`。
  - `lock_timeout` 的 `workspaceError` 字段加 `hint`。
- `src/fact/git-workspace.ts`
  - `withRepoLock` 传 `hint: \`pnpm keel unlock ${repoId} --force\``。
- 新增 `src/cli/unlock.ts`
  - `unlockRepo(repoId, { root?, force? })`：校验 repoId、读 owner、无 force 拒绝、
    有 force 删除。
  - `unlockMain(argv)`：解析 `<repoId>` 与 `--force`，输出持有者 / 结果。
- `src/cli/run.ts`
  - dispatch 增加 `unlock`；HELP 增加一行。
- 新增 `src/cli/unlock.test.ts`
  - 无锁 / 无 force / 有 force / 非法 repoId。
- `src/fact/file-lock.test.ts`
  - timeout detail 含 hint；原有「不自动破锁」用例保留。
- `.trellis/spec/backend/git-workspace.md`
  - 并发与锁一节补「显式 unlock」；错误契约补 `hint` 字段。

### 验证

```bash
pnpm vitest run src/cli/unlock.test.ts src/fact/file-lock.test.ts
pnpm run typecheck
```

### Review 重点

- `repoId` 含 `/`、`\`、`..` 时拒绝，且不触碰文件系统（路径穿越）。
- 无 `--force` 时锁目录与 `owner.json` 原样保留。
- `unlock` 不打开数据库；`runCli` 的 `closePool` 仍是 no-op / 安全。
- `lock_timeout` 的 hint 不包含 token 或用户绝对路径以外的敏感信息。

### 回滚点

回滚本阶段文件；已存在的锁仍需手工删除（回滚不会自动恢复）。

---

## 6. 收尾：全量检查、spec、提交

### 6.1 全量检查

```bash
pnpm run check
```

失败时按 `lint → typecheck → boundaries → generated → transitions → purity → test`
的顺序定位；不要用 `--no-verify` 或跳过测试。

验收测试默认不在 `check` 里（依赖模型 / 网络）。本任务改了
`v01-criterion-github.acceptance.test.ts` 的一行断言文本，至少保证 `typecheck`
覆盖它；如环境具备凭据，再单独跑：

```bash
pnpm run test:acceptance
```

### 6.2 spec 更新

- `.trellis/spec/backend/git-workspace.md`
  - `KEEL_HOME` 的向上查找规则；默认 blob 根。
  - `ensureWorktree` 的 `branchCreated` 语义与删除后重建的恢复路径。
  - `remove` 的 Result 错误契约。
  - 锁的显式 `unlock` 入口与 `hint` 字段。
- `.trellis/spec/backend/transition-effects.md`
  - T-015 / T-024 的清理；`cleanWorkspace` 失败写 `SideEffectIntent` 的纪律。
  - CI 事件的 `source` 字段（模拟 / GitHub）。
- `.trellis/spec/backend/orchestrator-loop.md`
  - S-PR_OPEN 的两条 CI 路径与来源标记。
- `README.md`
  - 项目根解析规则；终态清理 worktree（分支保留）。

### 6.3 提交

- 提交前 `git diff` 全量 review：
  - 没有 `.env`、token、绝对用户路径进入代码 / 文档。
  - 没有无关格式化（`biome check` 通过）。
- 提交信息建议：

```
fix(workspace): 基线与生命周期不再把目录存在当成状态正确

- CreateBranch 区分 worktree 新建与分支新建，删除后重建不再伪造 base_sha
- CI 事件携带 source，事件流可区分模拟与真实 CI
- KEEL_HOME 从 cwd 向上解析，默认 blob 根跟随 KEEL_HOME
- T-015 / T-024 清理 worktree；清理失败写 SideIntent 而非 Applied
- worktree 缺失时 prune 后重试；路径异常 fail closed
- 新增 keel unlock，lock_timeout 给出可操作提示
```

### 6.4 验收对照

逐条勾 `prd.md` 的 Acceptance Criteria；每条都要能指向一个测试或一条命令输出。
没有测试覆盖的条目，不要口头宣称完成。

---

## 7. 阶段顺序与依赖

```
0 基线
  └─ 1 P0-3 根解析
       └─ 2 P0-1 + P1-6 worktree
            ├─ 3 P0-2 CI 来源（独立，可与 2 并行）
            └─ 4 P1-4 + P1-5 终态清理（依赖 2 的 remove 契约）
                 └─ 5 P1-7 unlock（依赖 1 的根解析）
                      └─ 6 全量检查 / spec / 提交
```

- 2 与 3 改的文件基本不重叠，可以并行；但都要在 4 之前完成。
- 4 依赖 2 的 `remove` 返回 `Result`，不要提前做。
- 5 依赖 1 的根解析；不要在 1 之前做，否则 `unlock` 可能找错根。

## 8. 已知不在本任务内

- 把 CI 缺省改成 `real`。
- 自动 merge 的真实实现。
- 历史错误 `base_sha` 的数据修复。
- 旧分支 rebase / merge。
- `git add -A` 密钥扫描。
- harness 环境变量 / token 收敛。
- 8 位分支前缀碰撞。
- `register-repo` 并发重复注册。
- 全局并发上限配置化。
- 终态 task 仍执行 prepare 的优化。
