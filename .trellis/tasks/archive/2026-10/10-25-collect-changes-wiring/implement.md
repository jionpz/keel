# 执行计划：collectChanges 接进编排

> 设计见 `design.md`，需求见 `prd.md`。**按顺序做，每步先红后绿。**

## 0. 前置

- [ ] `python3 ./.trellis/scripts/task.py start 10-25-collect-changes-wiring`
- [ ] 基线：`pnpm run test` 全绿（记录当前用绿数，后面对比）

---

## 1. 采集层：基线 + 提交也看得见（AC3）

- [ ] `src/execution/adapters/git-diff.ts`
  - 新增 `gitHeadSha(cwd, opts): Promise<Result<string | null>>`（`git rev-parse HEAD`；
    非 git 仓 / 无 commit → `ok(null)`）
  - `GitDiffOptions` 加 `since?: string | null`；`collectGitDiff` 在 `since != null` 时：
    `patch = git diff <since>`、`files = git diff --name-status <since>`（含 rename 的
    `R100\told\tnew` 形态要解析对）**并上 porcelain 里的 `??` 未跟踪项**（`git diff`
    看不见未跟踪文件，而 develop 常是「新建一个文件」）、
    `commits = git log --format=%H <since>..HEAD`、`is_dirty = git status --porcelain` 非空
  - `since == null` 保持现状行为（**不许**顺手改既有语义，OMP/Human 的既有测试要能不动就过）
- [ ] `src/execution/adapters/git-diff.test.ts`
  - 用例：临时仓 → 改文件 → **commit** → `collectGitDiff({since: head})` 仍报
    `files_changed` 非空且 `commits.length === 1`
  - 用例：**新建未跟踪文件**（不 add）→ `collectGitDiff({since: head})` 报 `added`
  - 反例用例：`{since: null}` 在下同一状态下报空（证明缺陷真实存在，先红）

**验证**：`npx vitest run src/execution/adapters/git-diff.test.ts`

## 2. 三个 Adapter 传基线

- [ ] `claude-code.ts` / `omp.ts` / `human.ts`：`startRun` 时记 `baseSha`（失败记 `null`），
      `collectChanges` 传 `{ since: baseSha }`
- [ ] `claude-code.test.ts`：用注入的 spawn/git 断言 `collectChanges` 的 `since`
      来自 startRun 那一刻的 HEAD（对象身份/handle 无关，断言参数即可）
- [ ] `adapters.test.ts` 现有「collectChanges 读真实 git 脏树」保持绿（`since` 为当时 HEAD，
      语义等价）

**验证**：`npx vitest run src/execution/adapters/`

**REVIEW GATE 1** — 采集层自洽：提交/未提交/未跟踪三种形态都有断言后才继续。

## 3. SessionManager 采集（R1：dispose 之前）

- [ ] `src/execution/session/manager.ts`
  - `TurnOutcome.diff: WorkspaceDiff | null`
  - `advance`：`awaitResult` 返回 SUCCEEDED 之后、构造返回值之前调
    `spec.adapter.collectChanges(started.value)`；err → `diff: null`（不升级为 Run 失败）
  - 非 SUCCEEDED 分支不采集（那条路本来就要失败）
- [ ] `src/execution/session/manager.test.ts`
  - 顺序断言：`collectChanges` 调用早于 `dispose`
  - `collectChanges` 返回 err → `turn.ok === true` 且 `diff === null`

**验证**：`npx vitest run src/execution/session/manager.test.ts`

## 4. pipeline 透传

- [ ] `src/control/proposal/pipeline.ts`：`PipelineOutcome.diff: WorkspaceDiff | null`，
      取**最后一轮**（工作区累积，最后一轮已包含前面各轮）；失败的 `PipelineResult`
      分支不带 diff
- [ ] `src/e2e/session-pipeline.test.ts`（若断言了 outcome 形状）同步

**验证**：`npx vitest run src/e2e/session-pipeline.test.ts src/control/proposal/`

## 5. 编排层：fail-closed + 事件（AC1/AC4/AC5）

- [ ] `src/control/orchestrator/loop.ts`
  - 常量 `PATCH_LIMIT = 16_000`
  - `if (!outcome.ok) return ...` 之后、`UPDATE run SUCCEEDED` 之前插入 R5 检查：
    `stage === 'develop' && diff !== null && files 0 && commits 0` → `cancelRunWallClockTimer`
    → 返回 `PROTOCOL_ERROR`（detail 写清「develop 声称 implemented，但工作区无任何改动」）
  - `UPDATE run SUCCEEDED` 所在事务内追加 `INSERT INTO event (... 'WorkspaceDiffCollected' ...)`，
    payload 按 `design.md` §3（`patch` 截断到 `PATCH_LIMIT`、`patch_chars` 记截断前长度、
    `patch_truncated` 如实标记、`collected/collect_error`）
- [ ] `src/control/orchestrator/run-failure.test.ts` 新增两条
  - develop 空 diff → run 不 SUCCEEDED → `RunFailed` → T-030（attempt=2）
  - `collectChanges` 返回 err → run SUCCEEDED，事件 `collected=false` 且带 detail

**验证**：`npx vitest run src/control/orchestrator/run-failure.test.ts`

## 6. 上下文注入（AC2）

- [ ] `src/control/context/builder.ts`
  - `QA: ['role','rfc','state','diff']`、`Reviewer: ['role','rfc','state','diff']`
  - `load('diff')`：最近一条 `type='WorkspaceDiffCollected' AND payload->>'stage'='develop'`
    的 event，渲染文件清单 / commits / patch；`priority: 'required'`；
    `source_ref: event:WorkspaceDiffCollected@<seq>`
  - 截断时在文本里显式写「已截断，共 N 字符」
- [ ] `src/control/context/builder.test.ts`
  - 有事件 → section 出现，`source_ref` 带该 seq，内容含文件路径
  - 无事件 → section 缺席（**不是**「无改动」断言）
  - 非 develop 的事件不被误取（先写一条 stage='pm' 的新事件，仍取 develop 那条）

**验证**：`npx vitest run src/control/context/builder.test.ts`

**REVIEW GATE 2** — 端到端语义复核：QA 拿到的 diff 必须是 develop 那一条，且
`ContextBuilt` 可回溯。

## 7. 修既有 stub（R5 生效后的预期变红）

- [ ] 以下文件的 fake adapter 让 `collectChanges` 按 stage 返回：
      develop → 一个文件的 diff；其他 → 空
      - `src/e2e/execute-run-attempt.test.ts`
      - `src/e2e/timer.test.ts` / `timer-inflight.test.ts` / `timer-worker.test.ts`
      - `src/e2e/budget-fuse.test.ts`
      - `src/e2e/concurrency-guards.test.ts`（两处）
      - `src/e2e/orchestrator-workspace.test.ts`
      - `src/e2e/human-harness.test.ts`（若涉及）
      - `src/control/orchestrator/{critic-path,run-failure,declared-scope-prompt}.test.ts`
      - `src/control/orchestrator/ci-wiring.test.ts`（`Promise<never>` → 给真实返回值）
  - 顺手抽一个 `fixtures.ts` 里的 `dirtyDiff(path)` 减少 13 处重复

**验证**：`pnpm run test`

## 8. 全量门槛 + 真机验收（AC6/AC7）

- [ ] `pnpm run check`
- [ ] 真机跑一个任务到 S-DONE（临时仓，避免污染真实仓库），核对：
  - `SELECT seq, payload->>'stage', payload->'files_changed', payload->'commits'
     FROM event WHERE task_id='<id>' AND type='WorkspaceDiffCollected' ORDER BY seq`
     ↔ worktree 里 `git show --stat <commitAll sha>` 的文件清单一致
  - QA/review 的 `ContextBuilt` payload 里 `sections[]` 含 `id='diff'`
  - `payload->>'patch_chars'` 与 `patch_truncated` 自洽

## 9. 收尾（Phase 3）

- [ ] `.trellis/spec/backend/` 更新：新失败模式「假空 diff / 采集时机晚于 commitAll /
      采集晚于 dispose」，各配测试锚点（复用 `harness-adapter.md` 的表格形态）
- [ ] `docs/05-contracts/harness-adapter.md` §3.4：`commits` 由「恒空」改为
      「有基线时填本轮提交 SHA」
- [ ] `docs/07-flows.md` 第 20 步：标注已实现（事件 `WorkspaceDiffCollected`）
- [ ] 提交（`.trellis/spec` + `docs` + `src` 同一 commit 或分开，按现有习惯）

## 回滚点

| 步 | 回滚方式 |
|---|---|
| 1–2 | 采集层 additive，单独 commit；回滚 = 丢弃该 commit |
| 3–5 | fail-closed 是行为变更，单独 commit，便于 revert |
| 6 | 去掉配方里的 `'diff'` 即恢复旧上下文 |

## 不做（防膨胀）

- 不接 `post_develop` Policy 决策点、不做 diff 摘要、不解析「文件 ↔ AC」映射
- 不改 `--wall-clock` 默认值、不动 T-017 的 `firstRun('qa')`（另开任务）
