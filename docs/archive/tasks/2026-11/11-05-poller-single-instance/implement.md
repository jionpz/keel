# 实施计划：常驻进程单实例约束

> 依据 `prd.md` + `design.md`。所有代码注释与提交信息用中文，标识符用英文。

## 前置检查

- [ ] `git status` 仅含本任务规划文件；无未提交的无关改动。
- [ ] 基线绿：`pnpm run typecheck && pnpm vitest run src/cli/poller.test.ts`

## 步骤 1：锁模块 `src/fact/resident-lock.ts`

- [ ] 常量：`RESIDENT_LOCK_CLASS_ID = 0x4b45454c`；
      `RESIDENT_LOCK_OBJ_IDS = { poller: 1, 'timer-worker': 2 } as const`。
- [ ] 类型：

  ```ts
  export type ResidentRole = 'poller' | 'timer-worker'
  export interface ResidentLock {
    readonly role: ResidentRole
    release(): Promise<void>
  }
  export async function acquireResidentLock(role: ResidentRole): Promise<ResidentLock | null>
  export function lockErrorMessage(error: unknown): string
  ```

- [ ] `acquireResidentLock`：`new Client({ connectionString: connectionString() })` →
      `await client.connect()` → `SELECT pg_try_advisory_lock($1::int, $2::int)`。
      返回 `true` → 返回 lock；`false` → `await client.end()` 后返回 `null`。
      连接 / 查询抛错：尽力 `client.end()` 后原样抛出（CLI 负责文案）。
- [ ] `release()`：局部 `released` 标志保证幂等；先 `SELECT pg_advisory_unlock(...)`，
      再 `client.end()`；两步错误都吞掉（不改变调用方退出码）。
- [ ] `lockErrorMessage`：`Error.message` / `String(error)` 中的
      `postgres://…`、`postgresql://…` 替换为 `postgres://***`，其余原样返回。
- [ ] 不引入新依赖、不新增环境变量。

## 步骤 2：锁模块测试 `src/fact/resident-lock.test.ts`

真实 PostgreSQL（沿用现有测试的 `asOwner` / `closePool` 清理方式）。

- [ ] 同角色两次获取：第二次为 `null`。
- [ ] `poller` 持有时获取 `timer-worker` 成功（互不阻塞）。
- [ ] `release()` 后同角色可再次获取；重复 `release()` 不抛。
- [ ] 崩溃等价：用 `pg.Client` 直接执行同一组 key 的
      `pg_try_advisory_lock`，不 unlock 直接 `end()`；随后 `acquireResidentLock` 成功。
      （key 从模块导出的常量取，不复制字面量。）
- [ ] `lockErrorMessage` 把连接串替换为 `postgres://***`，普通消息原样保留。
- [ ] 每个用例 `try/finally` 释放，避免失败后污染后续用例。

**检查点**：`pnpm vitest run src/fact/resident-lock.test.ts` 全绿；
反例验证一次：临时去掉 `release()` 里的 unlock/end，确认「release 后可再获取」变红。

## 步骤 3：接 `pollerMain`

- [ ] `PollerMainDeps` 增加 `readonly acquireLock?: () => Promise<ResidentLock | null>`。
- [ ] 时序：全部参数 / 模式 / 模型 / allowlist / wall-clock 校验之后，
      构造 provider 与 `missingTokenHosts(...)` 之前获取锁。
- [ ] `null` → `console.error('poller: 已有实例在运行（同一数据库）。...')`，
      `process.exitCode = 1`，直接返回；不读 repo、不解析 token。
- [ ] 抛错 → `console.error('poller: 无法获取单实例锁：' + lockErrorMessage(e))`，
      退出码 1，直接返回。
- [ ] 获取成功：把现有 `try { 凭据预检 + runPollerForever } finally { closeDb }`
      整体放进锁的生命周期；`finally` 里**先** `await lock.release()`，再关池。
- [ ] 更新 `src/cli/poller.test.ts`：所有会走到锁的用例注入
      `acquireLock: async () => ({ role: 'poller', release: async () => {} })`；
      新增：
  - [ ] `acquireLock` 返回 `null` → 退出码 1、`listRepos` 未被调用、文案含「已有实例」。
  - [ ] `acquireLock` 抛 `Error('postgres://u:p@h/db down')` → 退出码 1、
        输出含 `postgres://***`、不含 `u:p`。
  - [ ] 循环正常结束 → `release()` 恰好一次。
  - [ ] `listRepos` 抛错 → 异常照常抛出，`release()` 仍恰好一次。

**检查点**：`pnpm vitest run src/cli/poller.test.ts` 全绿。

## 步骤 4：接 `timerWorkerMain`

- [ ] 新增并导出：

  ```ts
  export interface TimerWorkerMainDeps {
    readonly acquireLock?: () => Promise<ResidentLock | null>
    readonly drain?: (deps: WorkerDeps) => Promise<ReapStats>
    readonly run?: (deps: WorkerDeps, opts: { intervalMs: number }) => Promise<void>
  }
  export async function timerWorkerMain(argv, deps: TimerWorkerMainDeps = {}): Promise<void>
  ```

  默认分别指向 `acquireResidentLock('timer-worker')`、`drainAllDueTimers`、`runForever`。
- [ ] 时序：help → `livenessMode()` → `resolveHumanReviewTtlMs` 校验 →
      获取锁 → 构造 `LivenessStore` / `WorkflowDriver` → drain 或常驻。
- [ ] `null` 文案：`timer-worker: 已有实例在运行（同一数据库）；单次收割也持锁，请先停常驻实例。`
      退出码 1，不创建 store、不 drain。
- [ ] 抛错文案同 poller，前缀 `timer-worker:`。
- [ ] `finally`：先 `await store.close()`（仅在 store 已创建时），再 `await lock.release()`。
      `store.close()` 抛错不跳过 `release()`（用嵌套 try/finally 或分别 catch）。
- [ ] 新增 `src/cli/timer-worker.test.ts`（全部注入，不碰数据库）：
  - [ ] `--help` 不获取锁。
  - [ ] 锁为 `null` → 退出码 1、`drain` 未调用。
  - [ ] 单次模式 → `drain` 调用一次、`release` 一次。
  - [ ] `--interval 5` → `run` 收到 `{ intervalMs: 5 }`、`release` 一次。
  - [ ] `drain` 抛错 → 异常冒泡且 `release` 一次。
- [ ] 注意 `LivenessStore` 构造不连接数据库、`close()` 可安全调用；
      测试不注入 store factory。

**检查点**：`pnpm vitest run src/cli/timer-worker.test.ts src/cli/poller.test.ts`。

## 步骤 5：全量验证

- [ ] `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions / purity / test）。
- [ ] 确认没有测试依赖真实锁状态：`rg "acquireResidentLock" src` 只应出现在
      `src/fact/resident-lock.ts` 及其测试；CLI 测试全部注入。
- [ ] 手工验收（可选，需本地 DB 与 token）：
      终端 A `pnpm keel poller`；终端 B 同命令 → 退出码 1 且文案为「已有实例」；
      `kill -9` A 后 B 可正常启动；`keel timer-worker` 可同时运行。

## 回滚点

1. 步骤 1–2 独立：删除 `src/fact/resident-lock.ts` 与测试即可回到基线。
2. 步骤 3、4 分别只改一个 CLI 文件；任一接线出问题时先回退该文件，
   锁模块可保留但无人调用。
3. 全部改动在同一个提交里落地；归档前若 `pnpm run check` 红，整提交回退，
   不带半套接线归档。

## 交付后（Phase 3，不在实现子任务内）

- 更新 `.trellis/spec/backend/cli-lifecycle.md`：新增「常驻进程单实例」小节
  （锁键、专用连接、失败语义、SIGTERM 顺序、单次 timer-worker 也持锁）。
- 更新 `.trellis/spec/backend/index.md` 对应行。
- 提交、归档任务、写 journal。
