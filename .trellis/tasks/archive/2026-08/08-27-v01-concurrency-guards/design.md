# Design · 并发守卫

## 1. N2 乐观锁

文件：`src/control/driver/driver.ts`

```typescript
const upd = await c.query(
  `UPDATE task SET status=$2, updated_at=$3::timestamptz, terminal_at=...
   WHERE id=$1 AND status=$4`,
  [taskId, result.next_status, now, terminal, result.from],
)
if (upd.rowCount === 0) {
  return err(makeError('CONFLICT', 'task.status 乐观锁冲突', true))
}
```

`result.from` 来自纯函数转移结果，与读取时的 status 一致。

## 2. N3 RUNNING

- Migration `1000000000001_run-running-guards.sql`
- `loop.ts` `executeRun`：在 session 开始前 PENDING→RUNNING；失败时 session 返回 err 应将 run 标 FAILED（若尚无，补一条）

## 3. N4

- `src/control/concurrency/limits.ts`：`DEFAULT_MAX_RUNNING_RUNS = 3`
- `assertCanStartRun(c)` 在 RUNNING 转换前调用
- 编排器收到 CONFLICT/WORKSPACE_ERROR 类错误时正常停止

## 4. 测试

- `src/e2e/concurrency-guards.test.ts` 或 `src/fact/invariants.test.ts` 扩展
