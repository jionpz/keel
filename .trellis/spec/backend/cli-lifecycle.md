# CLI 进程生命周期（关池与常驻退出）

> 来源：`11-03-git-transport-auth` / `08-29-ingress-poller` 复核时实测到的两个缺陷。
> 代码：`src/cli/run.ts`（分发 + 关池）、`src/timer/worker.ts`（`runForever`）。
> 一句话：**CLI 进程必须能自己退出；常驻进程必须真的响应信号。**

---

## Scenario: 子命令退出与常驻循环退出

### 1. Scope / Trigger

- 触发：任何新增 CLI 子命令；任何新增常驻循环（poller / timer-worker / 未来调度器）。
- 影响面：进程能否退出、SIGTERM 后是否还在干活。
- 风险：两者失败时**都不会报错** —— 命令看着成功却挂着；常驻进程看着活着却在满速空转。

### 2. Signatures

```ts
// src/cli/run.ts —— 分发与生命周期
export function dispatch(argv: readonly string[]): Promise<void>
export interface RunCliDeps {
  closeDb?: () => Promise<void>   // 测试注入，断言「真的关了」
  dispatch?: (argv) => Promise<void> // 测试注入抛错，验证 finally
}
export function runCli(argv: readonly string[], deps?: RunCliDeps): Promise<void>

// src/cli/index.ts —— 只剩入口
runCli(process.argv.slice(2)).catch((e) => { console.error(...); process.exitCode = 1 })

// src/timer/worker.ts
export interface TimerSignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
}
export interface RunForeverOptions {
  intervalMs?: number
  signals?: TimerSignalSource
  drain?: (deps: WorkerDeps) => Promise<ReapStats>   // 测试注入
}
export function runForever(deps: WorkerDeps, opts?: RunForeverOptions): Promise<void>
```

### 3. Contracts

**关池**

- `runCli` 的 `finally` 里调 `closePool()`：成功、失败、抛异常三条路径都关。
- 关池失败**不改变退出结果**：`.catch(() => undefined)`。子命令已经跑完，
  `pool.end()` 报错只说明连接被对端提前关掉，不能把成功的命令变成失败。
- 子命令里**不要**再自己写 `finally { closePool() }` —— 会重复，且新命令一定漏。
  `pollerMain` 里保留的那一份是为了「不经过 runCli 直接调用」时也成立，`closePool` 幂等。
- 不连 DB 的子命令（如 `unlock`）同样走 `dispatch` / `runCli`：`closePool` 在池
  未创建时是 no-op，不为它开特例。

**常驻循环退出**

- SIGTERM / SIGINT：置 `stopRequested`，叫醒当前这一轮等待，`while` 跳出。
- 等待必须用**每轮新建**的 deferred + `clearTimeout`：
  收到信号后立刻退出，而不是挂满一个 interval。
- 信号监听在 `finally` 里 `off`：同一进程里多次 `runForever` 不叠加监听。
- drain 期间收到信号：本轮 drain 跑完就退出，不再进入等待、不再开新轮。
- 进行中的 drain / run **不强杀**：强杀会留下 RUNNING run（见 `ingress-poller.md`）。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 子命令正常返回 | 关池 → 进程退出（退出码 0） |
| 子命令抛错 | 关池 → 异常抛回 `index.ts` → 退出码 1 |
| 未知命令 | `exitCode = 2`，仍关池 |
| `pool.end()` 抛错 | 吞掉，不改变退出码 |
| SIGTERM 在 drain 中到达 | 本轮结束后退出 |
| SIGTERM 在等待中到达 | 立即退出（不等 interval） |
| 信号到达后再次到达 | `stopRequested` 已置位，幂等 |
| 未关闭连接池的碰库命令 | 打印完仍挂住（回归缺陷，见 §7） |

### 5. Good / Base / Bad Cases

- **Good**：`keel status <id>` 打印后 ~0.3s 退出；`runCli` 是唯一关池点。
- **Base**：`keel --version` 不碰库，`closePool()` 对未创建的 pool 是空操作。
- **Bad**：每个子命令自己 `finally { closePool() }`；或直接 `process.exit(0)`
  硬切（stdout 可能未 flush，且跳过 finally）。

### 6. Tests Required

`src/cli/run.test.ts`

- 成功路径调用 `closeDb` 一次
- 未知命令（`exitCode = 2`）后仍调用 `closeDb`
- `dispatch` 抛错时 `closeDb` 仍被调用，且原始异常继续抛出（`rejects.toBe(boom)`）
- `closeDb` 自身抛错时 `runCli` 仍 resolve

`src/timer/worker.test.ts`（注入 `signals` + `drain`，不碰数据库）

- 等待中收到 SIGTERM：立即 resolve，`drains === 1`
- drain 中收到 SIGTERM：本轮后退出，`drains === 1`
- 无信号时按 interval 继续下一轮（证明退出由信号驱动，不是只跑一轮）
- 退出后信号监听数归零（`listenerCount() === 0`）

`src/cli/cli.test.ts`：命令分发与 HELP 清单的漂移断言读 `run.ts`（HELP 已从 `index.ts` 迁出）。

### 7. Wrong vs Correct

**Wrong**：把「停止」做成循环外一个被信号 resolve 的 promise

```ts
const stopped = new Promise<void>((r) => process.once('SIGTERM', () => r()))
for (;;) {
  await drainAllDueTimers(deps)
  await Promise.race([sleep(intervalMs), stopped])   // 信号后 stopped 永久已 settle
}
```

信号一到 `stopped` 永久 settle，此后每轮 `race` 立即返回 —— 进程**满速反复 drain**，
既不再等待 interval，也永远不退出，只能 SIGKILL。

**Correct**：显式停止位 + 每轮新建的等待

```ts
let stopRequested = false
let wake: (() => void) | undefined
const onSignal = () => { stopRequested = true; wake?.() }
while (!stopRequested) {
  await drain(deps)
  if (stopRequested) break
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); wake = undefined; resolve() }
    timer = setTimeout(finish, intervalMs)
    wake = finish
  })
}
```

---

## Scenario: 常驻进程单实例（PostgreSQL advisory lock）

> 来源：`11-05-poller-single-instance`（issue #73 第 2 项）。
> 代码：`src/fact/resident-lock.ts`、`src/cli/poller.ts`、`src/cli/timer-worker.ts`。

### 1. Scope / Trigger

- 触发：新增任何常驻角色（当前 `poller` / `timer-worker`），或调整其启动 / 退出顺序。
- 影响面：同一数据库上的重复扫描、重复收割、`RunStalled` 重复投递。
- 风险：用 pidfile / 机器级锁会在 `kill -9`、掉电、容器重建后留下僵尸锁；
  用连接池持锁会随事务归还而失效。

### 2. Signatures

```ts
// src/fact/resident-lock.ts
export type ResidentRole = 'poller' | 'timer-worker'
export const RESIDENT_LOCK_CLASS_ID = 0x4b45454c            // ASCII "KEEL"
export const RESIDENT_LOCK_OBJ_IDS = { poller: 1, 'timer-worker': 2 } as const

export interface ResidentLock {
  readonly role: ResidentRole
  release(): Promise<void>                                  // 幂等
}

export async function acquireResidentLock(role: ResidentRole): Promise<ResidentLock | null>
export function lockErrorMessage(error: unknown): string     // 连接串脱敏

// CLI 注入点（测试不碰真实锁）
interface PollerMainDeps { acquireLock?: () => Promise<ResidentLock | null> }
interface TimerWorkerMainDeps {
  acquireLock?: () => Promise<ResidentLock | null>
  drain?: (deps: WorkerDeps) => Promise<ReapStats>
  run?: (deps: WorkerDeps, opts: { intervalMs: number }) => Promise<void>
}
```

### 3. Contracts

- **专用连接**：`new Client({ connectionString: connectionString() })`，**不经过连接池**。
  池化连接会随事务归还 / 被回收，锁的存活期就不再受进程控制。
- **加锁**：`SELECT pg_try_advisory_lock($1::int, $2::int)`。
  `classid` 固定 `0x4b45454c`（int4 范围内），`objid` 按角色区分；
  两个角色互不阻塞，同角色跨进程互斥。
- **返回语义**：拿到 → `ResidentLock`；同库同角色已持有 → `null`（明确启动失败，不等待）；
  连接 / 查询失败 → 抛错（不能把基础设施故障说成「已有实例」）。
- **释放**：`pg_advisory_unlock` + `client.end()`，错误吞掉；`release()` 用局部标志保证幂等。
  `client.end()` 本身也会释放会话锁，显式 unlock 只是让释放早于连接拆除。
- **崩溃**：会话锁绑定后端连接，进程消失 → 连接断开 → 服务器自动释放，无需手工清理。
- **作用域**：同一个数据库；同库不同机器同样互斥。跨库全局锁不在范围。
- **获取时序**：
  - `pollerMain`：全部参数 / 模式 / 模型 / allowlist / wall-clock 校验之后，
    **任何 repo 读取之前**（`missingTokenHosts` 之前）。
  - `timerWorkerMain`：help / liveness / TTL 校验之后，创建 `LivenessStore` 之前。
  - `--help` 与非法参数不取锁。
- **单次 timer-worker 也持锁**：它与常驻 worker 属于同一角色，并发会重复收割。
- **释放顺序**：
  - poller：`finally { await lock.release(); await closeDb() }`；release 抛错不跳过 closeDb。
  - timer-worker：`finally { try { await store.close() } finally { await lock.release() } }`；
    store 关闭失败不跳过 release。
- **取锁后的全部代码必须在 `try/finally` 内**：专用锁连接会占着事件循环，
  取锁与 `try` 之间再抛错会让进程既不退出也永远占着锁。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 同库已有同角色实例 | `acquireResidentLock` 返回 `null`；CLI 打印「已有实例在运行」，退出码 1 |
| poller 与 timer-worker 同时启动 | 两者都拿到锁（objid 不同） |
| 锁连接建立 / 查询失败 | 抛错；CLI 打印脱敏后的「无法获取单实例锁」，退出码 1 |
| 正常退出 / SIGTERM | 循环结束后 `finally` 释放锁，随后关池 |
| `kill -9` / 掉电 | 连接断开，PostgreSQL 自动释放；重启无需手工清理 |
| `release()` 抛错 | 吞掉，不改变退出码；仍尝试 `client.end()` |
| 锁已释放后再次 `release()` | 幂等 no-op |
| 错误消息含 `postgres://` / `postgresql://` | 替换为 `postgres://***` 后再输出 |

### 5. Good / Base / Bad Cases

- **Good**：终端 A 跑 `keel poller`；终端 B 同命令 → 退出码 1，文案指向已有实例；
  `kill -9` A 后 B 立即可启动。
- **Base**：`keel poller` 与 `keel timer-worker` 同时运行，互不拒绝。
- **Bad**：用 `<KEEL_HOME>/poller.pid` 判重 —— 崩溃后文件还在，必须人工删除；
  或从连接池借一条连接加锁后 `release()` 回池 —— 下一位使用者可能继承 / 丢失锁语义。

### 6. Tests Required

`src/fact/resident-lock.test.ts`（真实 PostgreSQL）：

- 同角色第二次获取返回 `null`；`poller` 与 `timer-worker` 可同时持有。
- `release()` 后可再次获取；重复 `release()` 不抛。
- **崩溃等价**：裸 `Client` 持锁期间先断言同角色第二次获取为 `null`，不 unlock 直接 `end()`，
  随后获取成功 —— 证明「自动释放」不是「本来就没锁」。
- `lockErrorMessage` 覆盖 `postgres://` / `postgresql://` 与普通消息。

CLI（全部注入 `acquireLock`，不依赖真实锁状态）：

- `null` → 退出码 1、`listRepos` 未被调用（poller）/ `drain` 未被调用（timer-worker）。
- 抛错 → 退出码 1、输出脱敏、不泄露 userinfo。
- 正常结束与抛错路径 `release()` 都恰好一次。
- `--help` 不取锁；单次 timer-worker 也取锁并在结束后释放。

### 7. Wrong vs Correct

**Wrong**：从连接池借连接，事务结束就归还

```ts
const client = await getPool().connect()
await client.query('SELECT pg_try_advisory_lock($1, $2)', [CLASS_ID, OBJ_ID])
client.release()   // 连接回到池里，锁的归属不再受进程控制
```

**Correct**：专用连接，持到进程退出

```ts
const client = new Client({ connectionString: connectionString() })
await client.connect()
const { rows } = await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
  [RESIDENT_LOCK_CLASS_ID, RESIDENT_LOCK_OBJ_IDS[role]])
if (!rows[0]?.locked) { await client.end(); return null }
// ...进程生命周期内一直持有；退出时 unlock + end
```

---

## 已知边界

- `console` 是 Web 服务，本身不返回；关池发生在它停止之后，属于同一规则。
- `runCli` 不管 `process.exit`：退出码由各子命令 / 入口设置，关池只负责句柄。
- 常驻循环不做硬取消（`runForever` 只保证不再开新轮），理由见 `ingress-poller.md`。
- 单实例锁不处理网络分区导致的「连接静默断开」：进程不会感知锁已丢失；
  需要更强保证时应在上层加租约心跳，而不是在锁模块里猜。
- `lockErrorMessage` 只脱敏 URL 形式连接串；libpq keyword/value DSN 不在当前连接方式内。
