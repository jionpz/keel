# 设计：collectChanges 接进编排

> 需求见 `prd.md`。本文只写技术设计与取舍。

## 1. 数据流（改后）

```
loop.executeClaimedRun
  └─ runSessionUntilValid(sessions, spec)            src/control/proposal/pipeline.ts
       └─ sessions.advance(handle, input)            src/execution/session/manager.ts
            ├─ adapter.startRun(spec')               ← 此处记下当时 HEAD 作为基线
            ├─ adapter.awaitResult(handle)
            └─ adapter.collectChanges(handle)        ← R1：dispose 之前；R2：相对基线
       ← PipelineOutcome.diff = 最后一轮的 WorkspaceDiff（工作区是累积的）
  ├─ R5 fail-closed：develop && diff 测得为空 → PROTOCOL_ERROR（不写 SUCCEEDED）
  ├─ asRole('keel_control')：UPDATE run SUCCEEDED + INSERT WorkspaceDiffCollected（同事务）
  └─ workspace.git.commitAll(...)                    ← 采集必须在它之前（R1）

qa / review run 的 ContextBuilder.build
  └─ load('diff')：读该 task 最近一条 stage='develop' 的 WorkspaceDiffCollected
```

**为什么采集点放在 `SessionManager.advance` 而不是 pipeline 或 loop**：
`advance` 是唯一同时持有 `SessionHandle` 与「adapter 状态仍存活」两个条件的层。
pipeline 的 `finally` 会 `sessions.close(handle)` → `adapter.dispose` → adapter 状态被删，
之后再 `collectChanges` 只会拿到 `NOT_FOUND`；loop 更晚（且那时 `commitAll` 已把工作树
提交干净，读到的是「假空」）。SessionManager 调 Adapter 契约方法是既有职责，不算越界。

## 2. 基线（R2）

`collectGitDiff` 目前只读 `git status --porcelain` + `git diff`（工作区 vs 暂存/HEAD）。
模型一旦自己 `git commit`，工作树干净 → 报「0 文件 0 提交」——**这是假空**，而 R5 会
据此判 develop 失败，把一个真实完成的 Run 判死。

改法（`src/execution/adapters/git-diff.ts`）：

```ts
export function gitHeadSha(cwd, opts): Result<string | null>   // 非 git 仓 → ok(null)

collectGitDiff(cwd, { since?: string | null })
  since == null  → 现状（工作区脏树）
  since != null  → patch     = `git diff <since>`            // 含已提交、已暂存、未暂存
                   files     = `git diff --name-status <since>` ∪ porcelain 里的 `??`（未跟踪）
                   commits   = `git log --format=%H <since>..HEAD`
                   is_dirty  = `git status --porcelain` 非空
```

**未跟踪文件必须并进来**：`git diff <since>` 看不见未跟踪文件，而 develop 的提示词
就写着「创建或修改一个文件」——新建文件恰恰是最常见的结果。只读 diff 会把
「新建了一个文件」报成空改动，R5 因此误杀。合并时以 diff 结果为主，`??` 补
`{change:'added'}`，同路径去重（porcelain 里 `??` 的路径不会出现在 diff 里，但仍要去重防御）。

三个 Adapter 在 `startRun` 记 `baseSha`（`spec.workspace.path` 上的一次 `git rev-parse HEAD`），
`collectChanges` 传 `{ since: baseSha }`。`gitHeadSha` 失败 → `since=null`，退回现状，
**不因此让 collectChanges 失败**（非 git 工作区仍可工作）。

> 与契约的差异：`WorkspaceDiff.commits` 文档写「v0.1 由调用方另行查询，这里恒空」。
> 有了基线它就是可数的，直接填上——填真值比留空更符合「不许用小值冒充不知道」。

## 3. 载体：event，不是 artifact（R3）

```sql
INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
VALUES ($1,$2,'WorkspaceDiffCollected',$3::jsonb,$4,$5)
```

payload：

```jsonc
{
  "stage": "develop",
  "attempt": 1,
  "collected": true,              // false = collectChanges 返回 err（R5 的「测不出来」）
  "collect_error": null,          // collected=false 时的 detail
  "files_changed": [{"path":"README.md","change":"modified"}],
  "commits": ["fcd8b0f..."],
  "is_dirty": true,
  "patch": "diff --git ...",      // 截断到 PATCH_LIMIT=16000 字符
  "patch_chars": 340,             // 截断前长度
  "patch_truncated": false
}
```

**为什么不是 artifact**：artifact 是「被冻结、有版本、会 supersede」的事实；
一次运行的 diff 是**观测记录**，随每次 run 追加，不构成决策也不需要版本链。
而且 artifact kind 由 `schema/` + `scripts/generate-types.ts` 生成，
新增 kind 要动生成物（`check:generated` 会盯），成本与收益不匹配。

写入时机：与 `UPDATE run SET status='SUCCEEDED'` **同一事务**（沿用该处已有的
「写回与核算之间不留窗口」纪律），失败则不落事件、run 也不会是 SUCCEEDED。

每轮都写（非 develop 阶段 patch 通常为空）：空事件本身就是事实
——「qa 跑完了，工作区没动」。也让 QA/Reviewer 之外的角色可回溯。

## 4. 上下文注入（R4）

`src/control/context/builder.ts`：

```ts
QA:       ['role','rfc','state','diff']
Reviewer: ['role','rfc','state','diff']
```

`load('diff')` 取「该 task 最近一条 `stage='develop'` 的 `WorkspaceDiffCollected`」，
渲染成：

```
## develop 的实际改动（git 事实，非模型自述）

文件：
- modified README.md
本轮提交：fcd8b0f（无则写「无」）
patch（若超大则标注「已截断，共 N 字符」）：
```diff
...
```
```

- `priority: 'required'`。QA 的全部工作就是核对这份改动，丢了它 QA 又退回对着 RFC 空想；
  required 被预算丢掉时该抛 `CONTEXT_BUDGET_EXCEEDED`（现有语义），**不许静默降级**。
  PATCH_LIMIT=16k 字符 ≈ 4k token，相对 40k 预算是可控开销。
- `source_ref: event:WorkspaceDiffCollected@<seq>` —— `ContextBuilt` 事件因此能回答
  「QA 当时看到的是哪一条 diff 事件」。
- 没有 develop 的 diff 事件（例如从 QA 起步的异常路径）→ 返回 null，section 缺席；
  这**不是**「没有改动」的断言，只是没有可注入的事实。
- 只取 `stage='develop'`：回退/返工时 PM、develop 自己也会写事件（空或半成品），
  取「最近一条」会把 QA 指到错误的 diff 上。

## 5. fail-closed 与错误类型（R5）

位置：`loop.executeClaimedRun`，`runSessionUntilValid` 返回 ok 之后、
`UPDATE run SET status='SUCCEEDED'` 之前。

```ts
const diff = outcome.value.diff
if (pending.stage === 'develop' && diff !== null
    && diff.files_changed.length === 0 && diff.commits.length === 0) {
  await cancelRunWallClockTimer(pending.id)
  return { ok: false, error: makeError('PROTOCOL_ERROR', '...'), usage: outcome.value.usage }
}
```

- 用 `PROTOCOL_ERROR`（retryable=true）而不是 `SCHEMA_VIOLATION`：提案已经通过校验并落库，
  不存在「回灌让它改格式」的余地了；这是「运行结束但结果不可信」——正是
  `RUN_STATUS_ERROR` 表里 FAILED 的既有语义（`session/manager.ts` 的注释）。
  可重试 → 走 T-030 重来一轮；重试到上限 → T-031 升人工。
- `diff === null`（采集失败）**不** fail-closed：没有证据 ≠ 有证据表明没干活。
  事件里 `collected=false` + `collect_error` 如实记录。
- 早退分支显式 `cancelRunWallClockTimer`（与既有 `!outcome.ok` 分支的差异属既有缺口，
  本任务不扩大改动面）。

## 6. 类型改动清单

| 文件 | 改动 |
|---|---|
| `contracts/harness-adapter.ts` | 无（`WorkspaceDiff` 已够用） |
| `execution/adapters/git-diff.ts` | 新增 `gitHeadSha`；`collectGitDiff` 加 `since` |
| `execution/adapters/{claude-code,omp,human}.ts` | startRun 记 `baseSha`；collectChanges 传 `since` |
| `execution/session/manager.ts` | `TurnOutcome.diff: WorkspaceDiff \| null`；advance 内采集 |
| `control/proposal/pipeline.ts` | `PipelineOutcome.diff`（最后一轮） |
| `control/orchestrator/loop.ts` | fail-closed + 同事务写 `WorkspaceDiffCollected` |
| `control/context/builder.ts` | QA/Reviewer 配方 + `load('diff')` |

## 7. 兼容性与回滚

- `PipelineOutcome` / `TurnOutcome` 只加字段；`PipelineResult` 失败分支不带 diff。
- 事件是新 type，不影响既有读者（没有按 type 白名单的消费者）。
- 回滚：`builder.ts` 去掉 `'diff'` 即恢复旧上下文；`loop.ts` 去掉 fail-closed 分支
  即恢复旧判定；两者的字段都是 additive，回滚不需要数据迁移。
- 已写入的 `WorkspaceDiffCollected` 事件在回滚后成为无人读取的历史事件，无害。

## 8. 验证策略

| 层 | 手段 |
|---|---|
| 基线覆盖提交 | `git-diff.test.ts`：临时仓 → commit → `collectGitDiff({since})` 仍报文件+commit |
| 采集时机 | `manager.test.ts`：stub adapter 记录调用顺序，断言 `collectChanges` 在 `dispose` 前 |
| fail-closed | `run-failure.test.ts`：develop 空 diff → `RunFailed` → T-030 重试 |
| 采集失败 | 同文件：`collectChanges` 返回 err → run 仍 SUCCEEDED，事件 `collected=false` |
| 上下文 | `builder.test.ts`：有 diff 事件 → section 出现且 `source_ref` 带 seq；无事件 → 缺席 |
| 真机 | 一个完整任务跑到 S-DONE，核对事件与 worktree commit 一致（AC6） |
