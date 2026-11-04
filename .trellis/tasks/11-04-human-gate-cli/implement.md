# 执行计划：人工介入入口

> 顺序是刻意的：先把「事件→事实」这条链补完整（步骤 1-2），再让 CLI 站在它上面（3-4），
> 最后才是界面提示（5）。每步留下可验证的状态，任何一步失败都能独立回退。

## 0. 开工前

- [ ] 读 `.trellis/spec/backend/transition-effects.md`、`database-guidelines.md`、
      `git-workspace.md`、`.trellis/spec/frontend/console-guidelines.md`。
- [ ] 确认工作树状态：本任务开始时 `git status` 已有多处未提交改动（console 改版与
      `11-03-git-transport-auth` 的残留），**不要**把它们混进本任务的 diff 里；
      提交时只 `git add` 本任务涉及的文件。

## 1. 事件与副作用（control 层）

- [ ] `src/control/transition/types.ts`：`ClarificationReceived` 增可选 `feedbackId?: string`。
- [ ] `src/control/driver/effects.ts`：`LinkFeedback` 有 `feedbackId` 时真写
      `task_feedback`（`ON CONFLICT DO NOTHING`）+ `SideEffectApplied`；否则维持 `recordIntent`。
      删掉 §591-593 那条「本轮不改」的注释。
- [ ] `src/control/driver/driver.ts`：`advance()` 增第 4 参 `opts?: { note?: string }`；
      转移成功后若 note 非空，同事务写 `HumanDecision` 事件（`payload: {decision, note}`）。
- [ ] `src/control/driver/effects.test.ts`：两条用例 —— 不带 `feedbackId` 仍是 intent；
      带 `feedbackId` 时 `task_feedback` 有行且事件是 `SideEffectApplied`。
- [ ] `src/control/driver/driver.test.ts`：`advance(..., {note})` 产生 `HumanDecision`；
      不传 note 时事件数量与现状一致（回归防线）。

验证：`pnpm run typecheck && pnpm exec vitest run src/control/driver`

**审查门 #1**（语义门）：确认 `LinkFeedback` 的两种分支各自写什么事件，
以及 `HumanDecision` 只在带 note 时出现。这一步的语义一旦错了，
后面所有 UI 都在展示错的事实。

## 2. 抽工作区准备（避免两套接线）

- [ ] 新建 `src/cli/task-workspace.ts`：`loadTaskWorkspace(taskId)` —— 从
      `run-task.ts:290-318` 原样搬出（读 task+repo → `ProjectBinding` → `prepareProject`），
      返回 `Result<{ binding: WorkspaceBinding; baseBranch: string; defaultBranch: string }>`。
- [ ] `run-task.ts` 改用它，行为必须逐字不变。
- [ ] 现有 `run-task` / `run-issue` / poller 测试：不变绿。

验证：`pnpm run typecheck && pnpm exec vitest run src/cli`

## 3. CLI 命令

- [ ] `src/cli/decide.ts`：
  - `decideTask(taskId, decision, opts)`：预检 `(status, control_mode)`（`keel_control` SELECT）
    → 不满足则返回结构化错误（不写库）；
  - `approve` 时先 `loadTaskWorkspace`，用带 workspace 的 driver 调 `advance`；
    `reject` / `rework` 用不带 workspace 的 driver；
  - `answerTask(taskId, text, opts)`：先 `asRole('keel_ingress')` 写 feedback
    （`source='manual'`，`external_ref='clarification:<taskId>:<uuid>'`），
    再 `advance(taskId, {type:'ClarificationReceived', feedbackId}, now)`；
    advance 失败时把 feedback id 打进错误信息。
  - `decideMain` / `answerMain`：argv 解析、帮助文本、退出码（0/1/2）按 design §2、§8。
- [ ] `src/cli/index.ts`：注册两个命令；`HELP` 与文件头注释同步。
- [ ] `src/cli/decide.test.ts`：预检失败的**零写入**断言（假 driver 调用计数为 0）、
      三种决定发出的 event、`--note` 透传、`answer` 的 feedback 先写后 advance 顺序。

验证：`pnpm run typecheck && pnpm exec vitest run src/cli/decide.test.ts`

**审查门 #2**：在真实库上走一遍（见 §7 手工验证），确认
`keel decide … approve` 之后 `keel run-task <id>` 能接着跑 develop。

## 4. 控制台提示条（只读）

- [ ] `src/cli/console.ts`：`EVENT_LABELS` 增 `HumanDecision: '人工裁决'`（`LinkFeedback`
      已在或补上）。
- [ ] `src/cli/console-page.ts`：新增 `.human-callout` 样式与
      `renderHumanCallout(task)`，在详情标题区渲染；命令文本用字符串拼接
      （**不用模板字符串**，不写 emoji）；`copy-btn` 复用现有实现。
- [ ] `src/cli/console.test.ts`：页面含 `human-callout` 与 `keel decide`；
      既有的 `POST → 405` 用例保持通过。

验证：`pnpm exec vitest run src/cli/console.test.ts && pnpm run lint`

**审查门 #3**（界面门）：用浏览器在真实数据上确认提示条只在这两个状态出现、
复制出来的命令能直接执行成功、其它状态不受影响（窄屏也不横向溢出）。

## 5. 端到端回归

- [ ] `src/e2e/timer.test.ts`：把「直接 `advance(ClarificationReceived)` 模拟人工回答」
      改成经 `answerTask`，断言 feedback 行 + `task_feedback` 行 + timer cancelled + 新 pm run。
- [ ] 跑 `pnpm run test`（含 e2e，需本地 Postgres）。

## 6. 文档与规格

- [ ] `.trellis/spec/backend/transition-effects.md`：补「人工事件的两个入口」与
      `LinkFeedback` 的落地条件、`advance(opts.note)` → `HumanDecision`。
- [ ] `.trellis/spec/frontend/console-guidelines.md`：补「人工闸门提示条是只读的，
      命令由页面拼、不新增写端点」。
- [ ] `.trellis/spec/backend/directory-structure.md`：登记 `src/cli/task-workspace.ts`。
- [ ] `docs/04-state-machine.md`：**不改**（转移未变），但确认没有文档说「人工事件由 X 发出」。

## 7. 手工验证（真实库）

```bash
pnpm run db:migrate            # 已有 schema，无新迁移，确认可重复执行
pnpm run build && node dist/cli/index.js status <taskId>
node dist/cli/index.js decide <taskId> approve --note "RFC 方案通过"
node dist/cli/index.js status <taskId>      # 状态 + TaskStatusChanged/HumanDecision 事件
node dist/cli/index.js run-task <taskId>    # 接着驱动 develop
```

- [ ] 在 `S-HUMAN_REVIEW` 的真任务上验证 approve 全链（分支真的建出来）。
- [ ] 在非该状态的任务上执行同一条命令：确认退出码 1 且事件数不变。
- [ ] 控制台（`pnpm run console`）能看到提示条，复制出的命令原样可执行。

## 8. 完成判据

- [ ] `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions / purity / test）。
- [ ] PRD 的 AC1-AC8 逐条有对应证据（测试名或手工步骤）。
- [ ] diff 只含本任务文件；`.trellis` 之外没有遗留调试脚本。

## 回滚点

| 步骤 | 回退方式 |
|---|---|
| 1 | 单文件回退 `effects.ts` / `types.ts` / `driver.ts`；`HumanDecision` 事件类型由 DB 自由 text 承载，无需迁移 |
| 2 | 抽出的 `task-workspace.ts` 删掉、`run-task.ts` 恢复内联 |
| 3 | 从 `index.ts` 摘掉两个 case（命令即消失） |
| 4 | 页面删掉 callout 渲染；`EVENT_LABELS` 多一条也不影响旧数据 |
