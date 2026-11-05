# 设计：常驻进程单实例约束（poller / timer-worker）

> 对应 PRD `prd.md`；issue #73 第 2 项。

## 不变量

1. 同一个 keel 数据库上，`poller` 与 `timer-worker` **各自**至多一个实例。
2. 锁随连接生命周期存亡：正常退出显式释放，`kill -9` / 掉电由 PostgreSQL 自动释放，
   不需要任何 pidfile 或手工清理。
3. 拿不到锁是**明确的启动失败**（非 0 + 可读文案），不是静默跳过或等待。
4. 不新增外部服务、不引入新依赖。

## 机制：PostgreSQL 会话级 advisory lock

新增 `src/fact/resident-lock.ts`：

```ts
export type ResidentRole = 'poller' | 'timer-worker'

export interface ResidentLock {
  readonly role: ResidentRole
  /** 幂等：先 unlock 再 end；释放失败不改变调用方退出码 */
  release(): Promise<void>
}

/** 拿到返回 lock；已被同库同角色持有时返回 null；连接/查询失败抛错 */
export async function acquireResidentLock(role: ResidentRole): Promise<ResidentLock | null>
```

- **专用连接**：`new Client({ connectionString: connectionString() })`，不经过连接池。
  池化的连接会随事务归还 / 被回收，锁的存活期就不受进程控制。
- 加锁：`SELECT pg_try_advisory_lock($1::int, $2::int)`。
  `classid = 0x4B45454C`（`KEEL`），`objid` 按角色固定：`poller = 1`、`timer-worker = 2`。
  两个角色互不阻塞，同一角色跨进程互斥。
- 释放：`pg_advisory_unlock` + `client.end()`。`end()` 本身也会释放会话锁，
  显式 unlock 只是让「已释放」早于连接拆除；两步都不因错误改变退出码。
- 崩溃：会话锁绑定后端连接，进程消失 → 连接断开 → 锁由服务器释放。
- 作用域是「同一个数据库」：advisory lock 的键空间属于当前数据库，
  同库不同机器同样互斥。

## CLI 接线

| 入口 | 获取时机 | 释放 |
|---|---|---|
| `pollerMain` | 参数 / model / wall-clock 校验之后，凭据预检**读取 repo 之前** | `finally`，在关池之前 |
| `timerWorkerMain` | 参数 / TTL 校验之后、创建 `LivenessStore` 之前 | `finally`，在 `store.close()` 之后 |

- 单次 `timer-worker`（无 `--interval`）同样持锁：它属于同一角色，
  与常驻 worker 并发会重复收割。被拒时文案建议先停常驻实例。
- 拿不到锁：`console.error('<role>: 已有实例在运行（同一数据库）…'); process.exitCode = 1; return`，
  不打印连接串、用户名、密码。
- 连接失败：捕获后打印脱敏后的错误消息，退出码 1；不把异常栈打进常规输出。
- SIGTERM：现有循环先停止认领 / 等在途工作结束，随后 `finally` 释放锁；
  退出码语义不变。

## 测试

- `src/fact/resident-lock.test.ts`（真实 Postgres）：
  - 同角色第二次获取返回 `null`；
  - `poller` 与 `timer-worker` 可同时持有；
  - `release()` 后同角色可再次获取，且重复 release 幂等；
  - **崩溃等价**：直接用 `Client` 加锁后 `end()`（不 unlock），下一次获取成功 ——
    钉住「不需要手工清锁」。
- CLI 注入点：`PollerMainDeps.acquireLock?`、`TimerWorkerMainDeps.acquireLock?`
  （返回 `ResidentLock | null`）。用例：
  - 返回 `null` → 退出码 1，循环 / drain 未被调用；
  - 返回 lock → 正常进入，且结束（含抛错）后 `release()` 恰好调用一次；
  - 测试不依赖真实 PostgreSQL 的锁状态（真实语义由 resident-lock 测试覆盖）。

## Out of scope（与 PRD 一致）

- 多实例分池、主从选举、故障转移。
- 跨数据库全局锁。
- 锁状态的只读展示。
