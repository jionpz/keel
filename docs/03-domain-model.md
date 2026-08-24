# 03 · 领域模型（Domain Model）

> 满足 PRD `R2`；关闭缺口 `G11`（RFC 无定义）。
> 术语一律以 [`02-glossary.md`](./02-glossary.md) 为准。

---

## 0. 本章的判据

> 一个开发者读完本章，应当能**直接写出 DDL**，不需要再发明任何字段。

因此本章给的是**逻辑 schema**（实体·字段·类型·键·不变量），
而不是"实体关系的文字描述"。

---

## 1. 实体全景

```
                        ┌────────────┐
                        │    repo    │
                        └──────┬─────┘
                               │ 1
                               │
       ┌────────────┐    n ┌───┴────┐ 1      n ┌─────────┐
       │  feedback  │◀────▶│  task  │─────────▶│   run   │
       └────────────┘ task_└───┬────┘          └────┬────┘
          (不可变)   feedback  │ 1                  │
                               │                    │ produced_by_run
                          n    ▼                    │
                        ┌──────────────┐◀───────────┘
                        │   artifact   │   (state / rfc / checkpoint /
                        └──────────────┘    critic_review / policy_decision /
                               ▲            capability_request)
                               │ 投影
                        ┌──────┴───────┐
                        │    event     │   append-only，全局单调 seq
                        └──────────────┘
```

**核心结构**：`task` 是宿主，`run` 是它的执行尝试，`artifact` 是产出的事实，
`event` 是所有变更的不可变流水。`feedback` 与 `task` 是**多对多**
—— 一条反馈可拆成多个任务，多条反馈也可合并成一个任务。

---

## 2. 实体定义

### 2.1 `repo`

Task 作用的目标仓库。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `provider` | `text` | `github` \| `gitlab` \| `local` |
| `remote_url` | `text` | |
| `default_branch` | `text` | PR 的目标分支 |
| `credential_ref` | `text` | **指向密钥管理的引用，绝不存明文凭据** |
| `created_at` | `timestamptz` | |

> `credential_ref` 是引用而非凭据本身 —— 见 `08-cross-cutting.md` 安全模型。

### 2.2 `feedback` — 不可变原始输入

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `source` | `text` | `web` \| `email` \| `api` \| `manual` |
| `external_ref` | `text` | 外部系统 id，用于去重 |
| `body` | `text` | **原文，不可信输入** |
| `received_at` | `timestamptz` | |

- `UNIQUE (source, external_ref)` —— 去重靠这里，不靠应用层判断
- **只允许 INSERT**。原文永不修改，永不删除。

> ⚠️ `body` 会进入 LLM 上下文，是 prompt injection 的主要入口。
> 任何消费它的地方都必须按不可信数据处理。

### 2.3 `task` — 工单，Task 级状态机的宿主

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `status` | `text` | **状态机位置**，取值为 `S-*`。见 `04-state-machine.md` |
| `control_mode` | `text` | 与 `status` 正交的维度：status 说业务走到哪，control_mode 说谁在驾驶。`auto` \| `paused` \| `human`，默认 `auto`。触发 `ControlModeChanged`（`C-*` 转移） |
| `title` | `text` | |
| `repo_id` | `uuid` | FK → `repo` |
| `base_branch` | `text` | |
| `work_branch` | `text` | `ai/task-<short_id>`，创建后不变 |
| `risk` | `text` | `low` \| `medium` \| `high` —— Policy facts |
| `complexity` | `text` | `low` \| `medium` \| `high` —— Policy facts |
| `budget_usd` | `numeric` | 成本上限，`NULL` = 用全局默认 |
| `current_run_id` | `uuid` | 便利字段，指向最新 run |
| `created_at` / `updated_at` | `timestamptz` | |
| `terminal_at` | `timestamptz` | 到达终态的时刻，`NULL` = 未终结 |

- `CHECK (status IN (...))` —— 枚举在 DB 层约束，不靠应用层
- **到达终态后不再变更，且不删除**

> 注意 `task.status` 是**位置**，不是内容。内容在 `artifact(kind='state')`。
> 这两者在初稿里是同一个词，见 `02-glossary.md` §6 废弃对照表。

### 2.4 `task_feedback` — 多对多关联

| 字段 | 类型 |
|---|---|
| `task_id` | `uuid` FK → `task` |
| `feedback_id` | `uuid` FK → `feedback` |

`PRIMARY KEY (task_id, feedback_id)`

### 2.5 `run` — 一次阶段执行尝试，Run 级状态机的宿主

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `task_id` | `uuid` | FK → `task` |
| `stage` | `text` | `pm` \| `brainstorm` \| `rfc_draft` \| `critic` \| `develop` \| `qa` \| `review` |
| `role` | `text` | `PM` \| `Critic` \| `Developer` \| `QA` \| `Reviewer` \| … |
| `attempt` | `int` | 第几次尝试，从 1 起 |
| `status` | `text` | `PENDING` \| `RUNNING` \| `SUCCEEDED` \| `FAILED` \| `TIMEOUT` \| `CANCELLED` |
| `harness_id` | `text` | 用了哪个 Harness |
| `harness_tier` | `text` | 该 Harness 实际生效的能力级别 `L0` \| `L1` \| `L2` |
| `session_ref` | `text` | Harness 侧的 session handle；仅当声明 `CAP-RESUME` 时有值 |
| `idempotency_key` | `text` | 派生自 `(task_id, stage, attempt)` |
| `started_at` / `ended_at` | `timestamptz` | |
| `error_kind` / `error_detail` | `text` | 仅失败态有值 |
| `tokens_in` / `tokens_out` | `bigint` | `NULL` = Harness 未上报（非 `CAP-COST`） |
| `cost_usd` | `numeric` | 同上 |
| `cost_basis` | `text` | `billed` \| `estimated` \| `unavailable`。禁止用 `0` 冒充 `unavailable` —— 两者在核算里是不同的事实 |

- `UNIQUE (task_id, stage, attempt)`
- `UNIQUE (idempotency_key)` ← **重放安全的落点**：重复投递不会产生第二次副作用
- **终态后不可变**

> `run` 在其 `session` 销毁后**依然存在**。这正是失败可追溯的原因 ——
> 会话没了，但"第 2 次尝试因超时失败"这个事实还在。

### 2.6 `artifact` — 统一产物表（Fact Plane 的载体）

**设计选择：单张多态表，而非每类产物一张表。**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `task_id` | `uuid` | FK → `task` |
| `kind` | `text` | `state` \| `rfc` \| `checkpoint` \| `stage_outcome` \| `critic_review` \| `policy_decision` \| `capability_request`。`event` 不在此列 —— 它有独立的表 |
| `key` | `text` | 同类多实例时的区分键。如 checkpoint 用 `run_id`；state 用 `''` |
| `version` | `int` | 同 `(task_id, kind, key)` 下递增，从 1 起 |
| `schema_version` | `text` | **产物 schema 自身的版本**，如 `1.0` |
| `body` | `jsonb` | 内容，schema 见 `06-artifacts.md` |
| `produced_by_run` | `uuid` | FK → `run`。哪个 run 提案的；`NULL` = 控制平面自产 |
| `committed_at` | `timestamptz` | |
| `committed_at_seq` | `bigint` | FK → `event(seq)`。**`getAsOf()` 的支撑列**，见下 |
| `superseded_by` | `uuid` | FK → `artifact`，被哪一版取代 |

- `UNIQUE (task_id, kind, key, version)`
- **只允许 INSERT**。"更新"= 插入新 version + 回填旧行的 `superseded_by`

> **大 body 落 blob（ADR-0004）**：`body` 超过 256 KB（`BLOB_THRESHOLD_BYTES`，
> `src/fact/blob.ts`）时，body 只存 `{"blob": "<sha256>"}` 引用，
> 真实内容进 `blob` 表。写顺序：先写 blob，后写 artifact ——
> 反过来会产生悬空引用；孤儿 blob 只是垃圾，可后台清理。
> 读回时由 `materialize()` 还原（`src/fact/artifact-store.ts`）。

#### 为什么需要 `committed_at_seq`

契约要求 `getAsOf(task_id, kind, key, at_event_seq)`
（[`05-contracts/artifact-store.md`](./05-contracts/artifact-store.md) §1.3）——
ContextBuilder 为 Developer 装填 `A-RFC` 时必须取**该 Run 开始时**的那一版。

**不能用 `committed_at` 近似**：`event.seq` 是全局单调的**逻辑序**，
`committed_at` 是**墙上时钟**。并发写入下两者会不一致，
而重放依赖的是 `seq`，不是时间。

提交时先 `INSERT event` 拿到 `seq`，再用它写 artifact（同一事务内）。

> 这一列是实现期发现的缺口：契约要求的能力，在原数据模型里没有支撑。
> 单看任一文档都自洽，问题在接缝处。

#### `superseded_by` 的唯一写入路径

`I2` 要求 `artifact` 只增不改（不授予 UPDATE），但回填 `superseded_by` 需要 UPDATE ——
两者直接冲突。

解法是 `SECURITY DEFINER` 函数 `keel_commit_artifact(...)`：
函数属主拥有 UPDATE 权限，调用者没有。于是**唯一能改 `superseded_by` 的路径就是这个函数**，
而它只做「插入新版 + 回填旧版」一件事。

这比"授予 UPDATE 然后指望大家只用来回填"强得多。

**为什么用单表**：

| 理由 | 说明 |
|---|---|
| 统一寻址 | 所有事实一个地址空间，审计与重放只需扫一张表 |
| 统一版本语义 | `version` + `superseded_by` 的不可变链条对所有产物一致 |
| **单一写入路径** | 只有一个 INSERT 入口，才好用授权把"执行平面不许写"钉死（见 §4） |

代价是 DB 层类型安全较弱 —— 由 `schema_version` + JSON Schema 校验在提交时补上。

### 2.7 `A-RFC` 的实体归属 · 关闭 G11

RFC **不是独立表**，它是 `artifact` 的一个 `kind`：

| 属性 | 取值 |
|---|---|
| `kind` | `rfc` |
| `key` | `''`（一个 Task 一条 RFC 主线） |
| `version` | RFC 的修订版本 |
| `produced_by_run` | 产出它的 PM run |

**冻结语义**：Task 进入 `S-RFC_READY` 时，当前 version 的 RFC **冻结**。
后续变更必须插入新 version 并回填 `superseded_by`，**不原地改写** ——
因为 Developer 已经据此开工，改写会让"当时按什么做的"这个事实消失。

RFC 的 `body` schema 见 [`06-artifacts.md`](./06-artifacts.md)。

### 2.8 `event` — append-only 事件流

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | `bigserial` | PK，**全局单调**。排序与重放游标 |
| `task_id` | `uuid` | FK → `task` |
| `run_id` | `uuid` | FK → `run`，可空 |
| `type` | `text` | 事件类型 |
| `payload` | `jsonb` | |
| `trace_id` / `span_id` | `text` | 可观测性关联，见 `08-cross-cutting.md` |
| `occurred_at` | `timestamptz` | |

- **只允许 INSERT。永不 UPDATE，永不 DELETE。**

Event log 一表四用：

| 用途 | 怎么用 |
|---|---|
| 审计 | 回答"这个 Task 到底发生了什么" |
| 重放 | 控制平面的确定性重放源 |
| 可观测 | trace/span 的天然载体 |
| 投影 | `artifact(kind='state')` 是 event 的投影 |

---

## 3. 不变量

这些是**系统正确性的定义**，不是建议。每条都应有对应的强制手段。

| ID | 不变量 | 强制手段 |
|---|---|---|
| `I1` | `event` 只增不改 | DB 授权：不授予 UPDATE / DELETE |
| `I2` | `artifact` 只增不改 | 同上；"更新"= 新 version |
| `I3` | 同一 `idempotency_key` 的副作用至多发生一次 | `UNIQUE (idempotency_key)` |
| `I4` | `task.status` 每次变更必然伴随一条 `event` | 同一事务内写入；违反即回滚 |
| `I5` | **Execution Plane 不得写 Fact Plane** | **DB 角色授权**（见 §4），不靠代码自觉 |
| `I6` | `feedback` 永不修改 | DB 授权：只授予 INSERT / SELECT |
| `I7` | 进入 `S-RFC_READY` 后 RFC 冻结 | 应用层校验 + `superseded_by` 链 |
| `I8` | 终态 Task 不再变更 | `CHECK`：`terminal_at IS NOT NULL` 时禁止 UPDATE（触发器） |

> `I5` 是中心不变量的落点。**它必须靠数据库授权强制，而不是靠约定。**
> 只写在文档里的边界，迟早会被一次"临时先这样"绕过 —— 而这条一旦被绕过，
> "State 是事实"整个原则就塌了。

---

## 4. 写权限矩阵 · 中心不变量的强制形式

对应两个数据库角色：`keel_control` 与 `keel_execution`。

| 实体 | Control Plane<br>`keel_control` | Execution Plane<br>`keel_execution` | 外部 Ingress |
|---|---|---|---|
| `repo` | `SELECT` | `SELECT` | 管理员 |
| `feedback` | `SELECT` | ⛔ **无直接访问**（经 Context） | `INSERT` `SELECT` |
| `task` | `SELECT` `INSERT` `UPDATE` | ⛔ **无直接访问**（经 Context） | ⛔ |
| `task_feedback` | `SELECT` `INSERT` | ⛔ | ⛔ |
| `run` | `SELECT` `INSERT` `UPDATE` | `SELECT` | ⛔ |
| `artifact` | `SELECT` `INSERT` | ⛔ **禁止** | ⛔ |
| `event` | `SELECT` `INSERT` | ⛔ **禁止** | ⛔ |

**矩阵中不存在"Execution Plane 可写 Fact Plane"的格子** —— 这不是疏漏，是本架构的定义性约束。

Execution Plane 想让任何东西落盘，**只有一条路**：emit 一个 Proposal，
由 Control Plane 校验（schema + policy）后代为写入。
见 [`05-contracts/session-manager.md`](./05-contracts/session-manager.md)。

注意 Execution Plane 对 `feedback` / `task` 也**没有直接读权限** ——
它看到的一切都经由 Context Builder 构造。
这既是 token 控制，也是防止 Agent 绕过上下文预算去"自己翻库"。

---

## 5. 索引与查询模式（实现提示）

| 查询 | 索引 |
|---|---|
| 取某 Task 的最新 State | `(task_id, kind, key, version DESC)` |
| 重放某 Task 的事件流 | `(task_id, seq)` |
| 找卡住的 Run | `(status, started_at)` where `status='RUNNING'` |
| 成本归集到 Task | `(task_id)` on `run`，聚合 `cost_usd` |
| 去重 Feedback | `UNIQUE (source, external_ref)` |

`artifact.body` 的热字段（如 `body->>'stage'`）按需加 GIN 或表达式索引，
不预先全量索引 JSONB。

---

## 6. 尚未决定的部分

| 项 | 状态 | 去向 |
|---|---|---|
| 大产物（完整对话、diff 全文）是否外置对象存储 | **已定案**：256 KB 阈值落本地 `blob` 表（ADR-0004） | `adr/0004`、`src/fact/blob.ts` |
| 是否需要 `task` 的乐观锁版本列 | 取决于 workflow engine 选型 | `adr/0003` |
| 多项目 / 多 repo 的租户隔离 | v0.1 不做 | `09-roadmap.md` Non-Goals |

---

**下一篇**：[`04-state-machine.md`](./04-state-machine.md) —— 把 `task.status` 与 `run.status` 形式化。
