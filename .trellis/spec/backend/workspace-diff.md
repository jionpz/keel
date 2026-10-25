# Workspace Diff（Run 到底改了什么）

> 记录**实际**做法与踩过的坑。来源：`10-25-collect-changes-wiring`（2026-10-26）。
> 代码在 `src/execution/adapters/git-diff.ts`、`src/execution/session/manager.ts`、
> `src/control/orchestrator/loop.ts`、`src/control/context/builder.ts`。

---

## Scope / Trigger

`collectChanges()` 是 Adapter 契约里 `[v0.1 必须]` 的方法，但**接进编排**之前它一直没人调用。
现在它是「develop 声称实现了」与「QA/Reviewer 核对改动」的唯一事实来源。

四条契约，破任何一条都会让这套机制说假话：

| 契约 | 破了会怎样 |
|---|---|
| 采集时机：`dispose` 与 `commitAll` **之前** | `NOT_FOUND`（state 已删）或「假空」（工作树已提交） |
| 基线：相对 `startRun` 时的 HEAD | 模型自己 commit 过 → 真完成的 run 被报成「0 文件」 |
| 未跟踪文件必须并进来 | `git diff` 看不见新建文件 → develop 常做的「新建一个文件」被报成空 |
| 「测不到」≠「没改动」 | 采集失败当成空 diff → 误杀合法 run；反之用空 diff 冒充失败 → 掩盖真故障 |

---

## 契约 1：采集点

```ts
// src/execution/session/manager.ts · advance()
const collected = await spec.adapter.collectChanges(started.value)
```

必须在 `advance` 里做，不能挪到编排层：

- `pipeline` 的 `finally` 会 `sessions.close(handle)` → `adapter.dispose` → adapter 内的
  RunState 被删，之后再 `collectChanges` 只能拿到 `NOT_FOUND`；
- 编排层稍后还会 `workspace.git.commitAll(...)`，提交之后 `git status` 干净，
  再读就是**假空**。

## 契约 2：基线

```ts
// adapters/{claude-code,omp,human}.ts · startRun()
const head = await gitHeadSha(spec.workspace.path)   // 起进程之前
// collectChanges()
return collectGitDiff(path, { since: state.baseSha })
```

`git status --porcelain` + `git diff` 只看工作树：模型自己 `git commit` 之后
它就是空的。所以基线用 `git diff <since>` + `git log <since>..HEAD`，
`commits` 字段由此填真值（契约原文「v0.1 恒空」已被取代）。

`gitHeadSha` 在非 git 目录返回 `ok(null)` —— **没有基线不是错误**，退回脏树语义即可。

## 契约 3：未跟踪文件

`git diff <since>` **看不见未跟踪文件**，而 develop 的提示词正是「创建或修改一个文件」。
`files_changed` 必须由 `git diff --name-status <since>` ∪ porcelain 的 `??` 合并而成
（`mergeFiles`）。只读前者会把「新建了一个文件」报成空改动，fail-closed 随即误杀。

## 契约 4：载体与判定

- 载体是 **event** `WorkspaceDiffCollected`（与 `UPDATE run SET status='SUCCEEDED'` 同事务）。
  不用 artifact：这是每次 run 追加的观测，不是要冻结、要版本链的决策。
- `collected:false` + `collect_error` 表示「没测到」；`is_dirty:null` 也是「未知」。
  **不许**用 `[]` / `false` 冒充。
- fail-closed 只在「测到了、而且确实是空的」时触发：`develop && diff !== null &&
  files 0 && commits 0` → `PROTOCOL_ERROR`（可重试 → T-030）。
- `patch` 超 `PATCH_LIMIT`（16k 字符）截断，`patch_chars` 记截断前长度、
  `patch_truncated:true` 如实标注；注入 QA 的文本里也写明「已截断」。
- QA / Reviewer 的配方加 `diff`，`priority:'required'`：拿不到实际改动就无法核对，
  预算放不下时按既有语义失败，不静默降级成「凭 RFC 猜」。
- 只取 `payload->>'stage'='develop'` 的那条：返工后 pm / develop 自己也会写事件，
  取「最近一条」会把 QA 指到错误的 diff 上。

---

## 失败模式与测试锚点

| 失败模式 | 守它的测试 | 反例验证 |
|---|---|---|
| 模型自己 commit → 报「没干活」 | `git-diff.test.ts` ·「有基线：已提交的改动仍可见」 | `since` 传 null → 红 |
| 未跟踪文件被漏掉 | `git-diff.test.ts` ·「新建但未 add 的文件报 added」 | 去掉 `mergeFiles` → 红 |
| 采集晚于 `dispose` | `manager.test.ts` ·「成功轮次带回 diff，且采集发生在 dispose 之前」 | 挪到 `close` 之后 → 红（`calls` 顺序变） |
| develop 空 diff 仍判成功 | `run-failure.test.ts` ·「D. develop 空 diff → 不算成功」 | 去掉 fail-closed 分支 → 红（只剩一次 SUCCEEDED） |
| 采集失败被当成没干活 | `run-failure.test.ts` ·「E. 采集失败不判死」 | 把 null 当空 diff → 红（run 变 FAILED） |
| QA 看不到 diff / 看错 diff | `builder.test.ts` · diff section 三例 | 配方去掉 `'diff'` → 红 |
| 全链路（真实工作树） | `e2e/collect-changes.test.ts`（L0，真实 git，零成本） | —— |

**真机**（`claude` + 真实模型）只用来确认「真实模型的改动形态能被采到」，不放进默认 check：
它的断言依赖模型说了什么，属验收套件。
