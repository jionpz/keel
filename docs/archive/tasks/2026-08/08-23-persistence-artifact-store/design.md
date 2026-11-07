# Design — 持久化层与 ArtifactStore

---

## 1. 设计目标

本任务的产品不是「能存数据」，而是**不变量被数据库拒绝违反**。

`docs/03-domain-model.md` §3 的注写得很直白：

> `I5` 是中心不变量的落点。**它必须靠数据库授权强制，而不是靠约定。**
> 只写在文档里的边界，迟早会被一次「临时先这样」绕过 ——
> 而这条一旦被绕过，"State 是事实"整个原则就塌了。

所以设计的重心在 §4（角色与授权）和 §6（反例验证），而不在 ORM 选型。

---

## 2. 发现：`getAsOf()` 在当前 schema 下无法实现 ⚠️

契约要求（`docs/05-contracts/artifact-store.md` §1.3）：

```
getAsOf(task_id, kind, key, at_event_seq) -> Artifact
```

> 取**某个事件序号时刻**的版本。ContextBuilder 为 Developer 装填 `A-RFC` 时，
> 必须取该 Run 开始时的那一版，否则 Developer 和 Reviewer 会看到不同版本的 RFC。

但 `docs/03-domain-model.md` §2.6 的 `artifact` 表**只有 `committed_at`（时间戳）**，
没有任何字段把产物与**事件序号**关联起来。

用时间戳近似是错的：`event.seq` 是全局单调的逻辑序，`committed_at` 是墙上时钟。
两者在并发写入下会不一致 —— 而重放依赖的是 `seq`，不是时间。

**修正**：`artifact` 增加一列

```sql
committed_at_seq  bigint NOT NULL REFERENCES event(seq)
```

在提交事务内，先 `INSERT event` 拿到 `seq`，再用它写 artifact。
于是：

```sql
SELECT * FROM artifact
WHERE task_id=$1 AND kind=$2 AND key=$3 AND committed_at_seq <= $4
ORDER BY version DESC LIMIT 1
```

**这一列要同步回 `docs/03-domain-model.md` §2.6** —— 同步文档，不让代码将就。

> 这是本任务规划期发现的第二类缺口（第一类是流程走查抓的）：
> **契约要求的能力，在数据模型里没有支撑**。
> 单看任一文档都自洽，问题在接缝处。

---

## 3. 选型

### 3.1 迁移工具（PRD Q1 → `ADR-0007`）

| 选项 | 评价 |
|---|---|
| **`node-pg-migrate`** | 成熟；支持纯 SQL 迁移；自带 advisory lock、applied 追踪、逐迁移事务 |
| 自研 runner | 约 80 行，但要自己处理并发部署时的 advisory lock、已应用追踪、部分失败 |

**选 `node-pg-migrate`。**

与 `ADR-0003`（自研状态机）的判断**不冲突**，两者的理由结构不同：

- 那里拒绝 Temporal，是因为它的核心卖点（workflow-as-code）**与已有的转移表重叠**
- 这里采用迁移库，是因为它解决的问题（顺序、加锁、追踪、部分失败）
  **没有任何一部分是我们已经有的**，而且这些正是自己写最容易出微妙错误的地方

迁移文件用**纯 SQL**，保证 PRD Constraint 1（DDL 是事实来源，含 GRANT）。

### 3.2 查询层（PRD Q2）

**raw `pg` + 手写 SQL。** 不用 ORM，不用查询构建器。

| 理由 | 说明 |
|---|---|
| 方法少 | 只有 7 个，抽象层的收益不足以抵消其成本 |
| 事务语义是核心 | 不变量依赖精确的事务边界，抽象层会把它藏起来 |
| **没有 ORM 能建模 GRANT** | 而本 schema 最重要的特性就是授权 |

类型安全的补法：手写行类型 + 一个**schema 漂移检查** ——
从 `information_schema` 读实际列，与 TS 行类型比对，不一致则测试失败。

> 这是骨架任务 `C1`/`C4` 那套手法的延续：**让漂移成为 CI 失败**，
> 而不是靠人记得两边一起改。

### 3.3 测试隔离（PRD Q3）

| 项 | 方案 |
|---|---|
| 测试库 | 独立 `keel_test` 数据库，`KEEL_DATABASE_URL` 可覆盖 |
| 迁移 | vitest `globalSetup` 中执行一次 |
| 用例间隔离 | `TRUNCATE ... RESTART IDENTITY CASCADE` |
| **角色测试** | 连接后 `SET ROLE keel_execution`，而不是用密码另开连接 |

`SET ROLE` 的好处：不需要为测试配置密码或改 `pg_hba.conf`。
前提是连接用户是目标角色的成员（`GRANT keel_execution TO <owner>`）。

⚠️ **必须实测确认 `SET ROLE` 真的会降权** —— 若连接用户是 superuser，
需确认权限检查走的是 `current_user`（`SET ROLE` 后已切换）而非 `session_user`。
这一点不靠推断，靠 §6 的反例测试给出答案。

---

## 4. 角色与授权 —— 本任务的核心

按 `docs/03-domain-model.md` §4 的矩阵：

| 表 | `keel_control` | `keel_execution` |
|---|---|---|
| `repo` | SELECT | SELECT |
| `feedback` | SELECT | ⛔ 无 |
| `task` | SELECT INSERT UPDATE | ⛔ 无 |
| `task_feedback` | SELECT INSERT | ⛔ 无 |
| `run` | SELECT INSERT UPDATE | SELECT |
| `artifact` | SELECT **INSERT** | ⛔ 无 |
| `event` | SELECT **INSERT** | ⛔ 无 |

注意 `keel_control` 对 `artifact` / `event` 也**只有 INSERT**，没有 UPDATE / DELETE ——
这就是 `I1` / `I2` 的强制方式。「更新」= 插入新 version + 回填 `superseded_by`……

> ⚠️ **回填 `superseded_by` 需要 UPDATE 权限，与「只 INSERT」冲突。**
>
> 解法：不用应用层 UPDATE，而是用一个 `SECURITY DEFINER` 函数
> `keel_commit_artifact(...)`，由它在函数内部完成「插入新版 + 回填旧版」。
> 函数属主拥有 UPDATE 权限，调用者没有 —— 于是**唯一能改 `superseded_by` 的路径
> 就是这个函数**，而它不接受任何其他形式的修改。
>
> 这比「授予 UPDATE 然后指望大家只用来回填」强得多。

### 4.1 角色创建的两个坑

1. Postgres 的 role 是**集群级**而非库级，且不支持 `CREATE ROLE IF NOT EXISTS`
   → 用 `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles ...) THEN CREATE ROLE ... END IF; END $$;`
2. 角色是 `NOLOGIN`（应用通过连接串的实际用户 + `SET ROLE` 使用），
   避免为每个角色管理密码

---

## 5. Schema 要点

7 张表按 `docs/03-domain-model.md` §2 实现，加上 §2 发现的 `artifact.committed_at_seq`。

| 要点 | 做法 |
|---|---|
| `task.status` 枚举 | `CHECK (status IN (...))`，15 个值。**由测试与 `src/shared/ids.ts` 比对** |
| `I3` 幂等 | `run` 表 `UNIQUE (idempotency_key)`、`UNIQUE (task_id, stage, attempt)` |
| `I8` 终态不可改 | `BEFORE UPDATE` 触发器：`OLD.terminal_at IS NOT NULL` 则 `RAISE EXCEPTION` |
| 版本唯一 | `artifact` `UNIQUE (task_id, kind, key, version)` |
| 事件单调 | `event.seq bigserial PRIMARY KEY` |
| 去重 | `feedback` `UNIQUE (source, external_ref)` |

索引按 `docs/03-domain-model.md` §5。

---

## 6. 不变量的反例验证

沿用骨架任务的结论：**未经反例验证的约束等同于没有约束**。
而那次的教训尤其适用于这里 —— 一条写错的 GRANT 和一条正确的 GRANT，
日常表现完全一样。

每条不变量一个测试，形式统一为「尝试违反 → 期望被拒绝」：

| 测试 | 期望 |
|---|---|
| `keel_control` UPDATE / DELETE `event` | 权限错误 |
| `keel_control` UPDATE / DELETE `artifact` | 权限错误 |
| **`keel_execution` INSERT `artifact`** | 权限错误 |
| `keel_execution` INSERT `event` | 权限错误 |
| `keel_execution` SELECT `task` | 权限错误 |
| UPDATE `feedback` | 权限错误 |
| UPDATE 已终结 `task` | 触发器异常 |
| 重复 `idempotency_key` | 唯一约束冲突 |
| `commit()` 的 `supersedes` 指向旧版 | 返回 `CONFLICT` |
| `commit()` 中途失败 | artifact 与 event **都不落盘** |

**测试不通过时，改的是授权而不是测试。**

---

## 7. blob 存储

```
blob/<hash[0:2]>/<hash[2:]>     # 内容寻址，sha256
```

阈值 256 KB（`ADR-0004`）。超过则 `artifact.body` 存
`{"$ref":"blob://<hash>","size":N,"preview":"..."}`。

**写入顺序：先 blob，后 artifact。**
孤儿 blob 由后台清理；反过来会产生悬空引用，不可接受。

接口按对象存储语义设计（`put(bytes) -> hash` / `get(hash) -> bytes`），
以便日后换 S3 兼容存储时不改调用方。

---

## 8. 新增依赖

| 依赖 | 解决什么 |
|---|---|
| `pg` | Postgres 驱动 |
| `@types/pg` | 类型 |
| `node-pg-migrate` | 迁移的顺序 / 加锁 / 追踪 / 部分失败（见 §3.1） |

没有引入 ORM、查询构建器、连接池封装（`pg` 自带 Pool）。

---

## 9. 风险

| 风险 | 对策 |
|---|---|
| `SET ROLE` 在 superuser 下不降权 | §6 的反例测试会直接暴露。若成立则改用独立角色连接 |
| CI 无 Postgres | GitHub Actions 用 `services: postgres`；本地用 homebrew 实例 |
| `SECURITY DEFINER` 函数被滥用 | 函数只做「插入新版 + 回填旧版」一件事，参数不接受任意 SQL |
| 迁移工具与 ESM 冲突 | 用其 CLI 而非 API；若仍冲突则回退自研 runner 并记入 ADR |
| schema 与文档漂移 | `information_schema` 比对测试（§3.2） |
