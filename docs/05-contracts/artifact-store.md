# `ArtifactStore`

> 满足 PRD `R4`。事实平面的读写边界。

---

## 0. 职责

`ArtifactStore` 是 **Fact Plane 的唯一入口**。它的存在意义不是"封装数据库访问"，
而是**把"只有 Control Plane 能写事实"这条不变量收敛到一个可审计的位置**。

因此它的接口是刻意窄的：没有 `update`，没有 `delete`。

---

## 1. 接口

### 1.1 `commit()` `[v0.1 必须]`

```
commit(proposal: Proposal, ctx: CommitContext) -> ArtifactRef | Error

CommitContext {
  run_id:         string | null      // null = Control Plane 自产
  verdict:        ProposalVerdict    // 必须已通过校验流水线
  emit_event:     boolean            // 默认 true
}
```

**前置条件**：`proposal` 已通过 [`session-manager.md`](./session-manager.md) §1.2 的五步校验。
`ArtifactStore` **不重复做业务校验**，但会做两项硬检查：

| 检查 | 失败 |
|---|---|
| `supersedes` 指向的 artifact 是当前最新版 | `CONFLICT` —— 有并发写入 |
| `(task_id, kind, key, version)` 未被占用 | `CONFLICT` |

**事务语义**：写 `artifact` + 回填旧行 `superseded_by` + 写 `event`
**必须在同一事务内**完成（不变量 `I4`）。任一失败则整体回滚。

**版本分配**：`version = max(existing) + 1`，在事务内取，靠 `UNIQUE` 约束防并发。

### 1.2 `get()` / `latest()` / `history()` `[v0.1 必须]`

```
get(task_id, kind, key, version)  -> Artifact | Error
latest(task_id, kind, key)        -> Artifact | Error     // superseded_by IS NULL 的那条
history(task_id, kind, key)       -> Artifact[]           // 按 version 升序，含已被取代的
```

`history()` 返回**包含已取代版本**的完整链 —— 这是"当时是按哪一版做的"能被回答的原因。

### 1.3 `getAsOf()` `[v0.1 必须]`

```
getAsOf(task_id, kind, key, at_event_seq: integer) -> Artifact | Error
```

取**某个事件序号时刻**的版本。

> 这个方法看起来像是可延后的便利功能，实际上是 `[v0.1 必须]`：
> ContextBuilder 为 Developer 装填 `A-RFC` 时，必须取**该 Run 开始时**的那一版，
> 而不是最新版（见 [`context-builder.md`](./context-builder.md) §3.3 的注）。
> 没有这个方法，Developer 和 Reviewer 就可能看到不同版本的 RFC。

### 1.4 `appendEvent()` `[v0.1 必须]`

```
appendEvent(event: Omit<A-Event, 'seq'>) -> seq: integer | Error
```

只增不改（不变量 `I1`）。入参不含 `seq` —— 它是数据库 bigserial 自增列
（DDL `event.seq`），调用方伪造等于撒谎；返回分配到的全局单调 `seq`。

`occurred_at` 由调用方注入并原样落库，不依赖 DB 默认 `now()` ——
事件时间是「这个事实何时发生」的重放依据，读时钟会破坏可重放性（ADR-0003）。

### 1.5 `readEvents()` `[v0.1 必须]`

```
readEvents(task_id: string, from_seq: integer, limit: integer) -> A-Event[]
```

重放与审计的入口。按 `seq` 升序。

### 1.6 `project()` `[可延后]`

```
project(task_id: string, up_to_seq: integer) -> A-State
```

从事件流重建 `A-State` 投影。

v0.1 直接读 `latest(task_id, 'state', '')` 即可，不需要真的做投影；
本方法留给阶段二的"重建/校对"能力 —— 用它可以检测存储的 `A-State`
与事件流是否已经漂移。

---

## 2. 明确不提供的方法

| 不提供 | 原因 |
|---|---|
| `update()` | 违反不变量 `I2`。修改 = `commit()` 一个新 version |
| `delete()` | 事实不可删除。生命周期终结走归档，不走删除 |
| `rawQuery()` | 会成为绕过所有校验的后门 |

> 这三个"不提供"比上面六个"提供"更重要。
> 一个 `update()` 方法一旦存在，六个月后一定会有人用它"临时修一下数据"，
> 而那一刻起 `history()` 就不再可信了。

---

## 3. 归档

Task 到达终态且超过保留期后：

| 数据 | 处理 |
|---|---|
| `A-State`、`A-RFC` | **永久保留**（它们是这个 Task 做过什么的答案） |
| `A-Checkpoint` | 可归档到冷存储 —— Session 已不可能恢复，只剩审计价值 |
| `event` | 永久保留 |
| 完整对话记录（若采集） | 冷存储；见 [`../adr/0004-persistence.md`](../adr/0004-persistence.md) |

> 初稿 §11 说"完整对话可以作为 Debug / Audit 数据保存，但不是每次恢复都加载"——
> 本文档采纳该主张：完整对话**不进** `artifact` 表，避免热路径被大对象拖累。
> 具体存储介质见 ADR-0004。
