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

## 已知边界

- `console` 是 Web 服务，本身不返回；关池发生在它停止之后，属于同一规则。
- `runCli` 不管 `process.exit`：退出码由各子命令 / 入口设置，关池只负责句柄。
- 常驻循环不做硬取消（`runForever` 只保证不再开新轮），理由见 `ingress-poller.md`。
