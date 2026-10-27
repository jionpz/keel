# 数据库约定

> 记录**实际**做法。来源：`08-23-persistence-artifact-store` 任务。
> 选型理由见 `docs/adr/0007-migration-and-query-layer.md`。

---

## 事实来源是 SQL，不是 TypeScript

`migrations/*.sql` 是 schema 的唯一事实来源，**包括 GRANT**。

不用 ORM 也不用查询构建器。核心理由：**没有 ORM 能建模授权**，
而本项目 schema 最重要的特性恰恰是授权（`docs/03-domain-model.md` §4）。

TS 侧手写行类型，一致性由**漂移检查**保证 ——
从 `pg_constraint` / `pg_tables` 读实际定义与 TS 常量比对，不一致则测试失败。
见 `src/fact/artifact-store.test.ts` 的「schema 与代码的一致性」。

---

## 一切写入以角色身份进行

```ts
await asRole('keel_control', async (c) => { /* ... */ })
```

**永远不要用 `asOwner` 写生产数据。** 它只用于测试装置与迁移。

理由不是风格洁癖：`keel_control` 对 `artifact` / `event` **只有 SELECT + INSERT**，
于是 `I1` / `I2`（只增不改）由数据库保证 ——
即使代码里写错一条 UPDATE，也会被拒绝。绕过角色就等于放弃这层保护。

`asRole` 用 `SET LOCAL ROLE` + 事务包裹，角色不会泄漏到连接池的下一个使用者。

### 三个角色的边界

| | `keel_control` | `keel_execution` | `keel_ingress` |
|---|---|---|---|
| `artifact` / `event` | SELECT + INSERT | **无任何权限** | **无** |
| `task` | 按矩阵 | **无任何权限**（含 SELECT） | **无** |
| `feedback` | SELECT only | **无** | **SELECT + INSERT** |
| `run` | SELECT INSERT UPDATE | SELECT | **无** |
| `repo` | SELECT | SELECT | SELECT |

`keel_execution` 连 `task` 的 SELECT 都没有 —— 它看到的一切都应经由 Context Builder。
这既是 token 控制，也是防止 Agent 绕过上下文预算去「自己翻库」。

`keel_ingress` 是 docs/03 §4「外部 Ingress」列的落地角色（`migrations/1000000000003_github_ingress.sql`）：
**只**能往 `feedback` INSERT，不能建 task。task 创建必须经 `WorkflowDriver.intake()`
（`keel_control` 事务内真实化 T-001）。不要用 `asOwner` / `keel_control` 写 feedback ——
control 对 feedback 刻意只读，这是矩阵约束。

`repo` INSERT 不属于任何运行时角色：`keel register-repo` 用 `asOwner` 是管理员操作，
与「运行时角色不写 repo」一致；不要为便利给 `keel_ingress`/`keel_control` 加 repo INSERT。

### T-001 / intake 入口（from:null 转移）

`transition()` **故意**不匹配 `from: null`。创建 Task 走平行入口
`WorkflowDriver.intake()`，不走 `advance()`。`CreateTask` 在 `applyEffects` 里抛错
（只能经 intake）；`LinkFeedback` 仍可 `recordIntent`（T-007 澄清回流也发它）。

---

### `asRole` 只在**抛错**时回滚 —— `return err` 照样 COMMIT

`asRole` 的形状是 `BEGIN → SET LOCAL ROLE → fn(c) → COMMIT`（`src/fact/db.ts`），
`fn` 里**正常返回就提交**，不管返回的是 `ok` 还是 `err`。于是：

- 想在事务内「撤销刚才那步」→ 必须 `throw`，不能 `return err`；
- 想「先写后判断再放弃」→ 这个写法在本仓库不成立。

驱动里已经有一处踩在这个边界上：`advance()` 先 `UPDATE task.status`
（`driver.ts`）再 `applyEffects`。所以副作用执行器**不能**因为「发现不对」就
`return err` —— 状态已经写进去了，`return err` 只会把它一起提交，
调用方看到的却是「没成功」。要中止只能抛错，而那会把整次转移回滚
（含已经算好的 `task.status`），语义是「这次转移没发生」，不是「转移发生了但某步失败」。

判断是否需要「聚合并返回部分失败」时，先问：这些写入能不能接受部分生效？
能 → 用 `AppliedEffect.outcome` 这类**结果记录**表达，不碰事务；
不能 → 抛错。

---

## `superseded_by` 只能经 `keel_commit_artifact` 写

`I2` 要求不授予 UPDATE，但「新版取代旧版」需要回填 `superseded_by` —— 直接冲突。

解法是 `SECURITY DEFINER` 函数：函数属主有 UPDATE 权限，调用者没有。
于是**唯一能改 `superseded_by` 的路径就是这个函数**，而它只做这一件事。

这比「授予 UPDATE 然后指望大家只用来回填」强得多。

---

## 版本号是乐观的

`nextVersion()` = `max(version) + 1`，不加行锁（`keel_control` 也拿不到行锁）。
并发下两个调用可能算出同一个版本号，由
`UNIQUE (task_id, kind, key, version)` 让后到者失败，转成 `CONFLICT` 由调用方重试。

---

## 错误映射

| Postgres | 映射为 |
|---|---|
| `23505` unique_violation | `CONFLICT`（可重试） |
| `40001` serialization_failure（含函数抛的 CONFLICT） | `CONFLICT` |
| 查询无结果 | `NOT_FOUND`（不可重试） |
| **其余** | **抛出，不包装** |

最后一行是刻意的：意外的数据库错误是编程错误或基础设施故障，
把它包装成 `Result` 会让它被静默处理掉。
只有**可预期的**失败才返回 `Result`（见 `error-handling.md`）。

---

## 大对象走 blob

`body` > 256 KB 时落内容寻址的 blob 存储，`artifact.body` 只存
`{"$ref":"blob://<hash>","size":N,"preview":"..."}`（`ADR-0004`）。

**写入顺序：先 blob，后 artifact。**
孤儿 blob 只是垃圾、可后台清理；反过来会产生**悬空引用**，不可接受。

---

## 测试

| 项 | 做法 |
|---|---|
| 测试库 | `keel_test`，`KEEL_DATABASE_URL` 可覆盖 |
| 迁移 | `vitest.globalSetup.ts` 中执行一次 |
| 用例隔离 | `beforeEach` 里 `TRUNCATE ... RESTART IDENTITY CASCADE` |
| 角色测试 | `SET ROLE`，不需要密码。**实测确认它对 superuser 也降权** |
| **文件间隔离** | `fileParallelism: false` —— 多文件共享同一个库，并行会互相 TRUNCATE |

### 不做「数据库不可用则跳过」

那是假绿：不变量测试全被跳过时，输出和「全部通过」看起来一样。
连不上就让测试失败。

### 不变量必须用反例验证

`src/fact/invariants.test.ts` 的每个用例都是一次**主动违规尝试**，期望被拒绝。

**测试不通过时改授权，不改测试。**

这一条有代价高昂的先例：骨架任务的 `check:generated` 因为比较基准写错，
在主干上一直是绿的却拦不住手改，是反例验证抓出来的。
**一条写错的 GRANT 和一条正确的 GRANT，日常表现完全一样。**

### `repo.local_path`（10-27-local-project-binding）

`migrations/1000000000005_repo_local_path.sql`：

```sql
ALTER TABLE repo ADD COLUMN local_path text;
ALTER TABLE repo ADD CONSTRAINT repo_local_path_absolute
  CHECK (local_path IS NULL OR local_path LIKE '/%');
CREATE UNIQUE INDEX repo_local_path_unique
  ON repo (local_path) WHERE local_path IS NOT NULL;
```

三条约束各自防的东西：

| 机制 | 防什么 | 不能防什么 |
|---|---|---|
| `NULL` = managed | 未绑定的 repo 保持克隆模式，语义由「有没有值」承载 | — |
| `CHECK LIKE '/%'` | 相对路径 / 空串被写进库 | 符号链接、`..`、重复分隔符 |
| 部分唯一索引 | 两个 repo 指向同一目录 | 同一目录的**不同写法**（`/a/./b`、`/a/b/`） |

所以**规范化是应用层的前置条件**，不是可选的清洗：
`register-repo` 先 `canonicalizeDir`（`resolve` → `statSync` 必须是目录 →
`realpathSync`）再写库。DB 只做第二道防线 —— 期望数据库解决别名问题会把
真实路径语义（符号链接解析）错误地塞进 SQL。

并发的 `register-repo` 撞同一路径时，靠唯一索引报 `23505`，
CLI 捕获后查占位者，输出 `[local_path_taken] path="..." repo="<自己>" occupied_by="<对方>"`。

授权矩阵不变：`repo` 对三个运行时角色仍然只读（见上表）。
绑定更新走 `asOwnerTx`（`src/fact/db.ts`）——**`asOwner` 不开事务**，
只有 `asOwnerTx` / `asRole` 会 `BEGIN`；`SELECT ... FOR UPDATE` 必须在这两者之内。

已知限制：`repo.remote_url` 没有唯一索引，并发注册同一个 remote 仍可能产生两条
repo 记录。这是既有问题，不在本任务范围内（见 `prd.md` Open Questions #7）。
