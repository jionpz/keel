# keel 控制台 + demo APP 全流程演练

## Goal

让 keel 的「整条研发闭环」第一次变得**可见**：
1. 提供一个只读 Web 控制台，一屏看到 task 状态、run、事件时间线、产物；
2. 新建一个最小 demo APP 仓库，用真实 GitHub Issue 跑完 `S-NEW → S-DONE`，
   产出真实 PR 且 CI 真实通过；
3. 控制台里能回看这次跑动的完整事件流。

## 背景

- keel 当前只有 CLI（`status` / `timeline`），`docs/09-roadmap.md` 明确把 UI 划为 Non-Goal；
  但「UI 是消费者，不是被验证的东西」不等于不能有一个只读观测面。
- `keel_dev` 已有 7 个 task / 23 个 run / 109 条事件，具备可视化素材。
- 2026-10-25 的 demo 只跑到 `file://` 本地仓库，没有真实 PR / 真实 CI，
  闭环的最后两跳（T-021 / T-024）没有被真实验证。

## Requirements

### R1 控制台只读

- 只读：不新增任何写 Fact Plane 的路径；只用 `SELECT`。
- 连接角色用 `keel_control`（现有授权足够的唯一读角色），不引入新角色。
- 进程只绑定 `127.0.0.1`，不作为公网服务。

### R2 单命令启动，零新依赖

- `pnpm run console` 启动；端口默认 `4321`，可用 `KEEL_CONSOLE_PORT` 覆盖。
- 数据库沿用 `KEEL_DATABASE_URL` / `DATABASE_URL` 的既有解析（`src/fact/db.ts`）。
- 不引入 React / Vite / Express 等依赖；单文件 HTML + 原生 JS，由 `node:http` 提供。

### R3 页面信息完整

- 任务列表：id、标题、状态、control_mode、repo、更新时间。
- 任务详情：状态、control_mode、创建/更新时间、run 列表（stage/attempt/status/harness）、
  事件时间线（seq/时间/类型/payload）、产物（kind/key/version，含 RFC 与 stage_outcome）。
- 状态机视图：从代码转移表（`src/control/transition/table.ts`）渲染，高亮当前状态。

### R4 可观察运行中的任务

- 页面支持自动刷新（默认 5s，可关），用于盯 `run-issue` 跑到终态。
- 刷新只重新拉数据，不改变任何服务端状态。

### R5 demo APP 可被真实驱动

- 新建 GitHub 仓库（`jionpz/keel-demo-app`），最小 Node 应用 + 原生测试 + GitHub Actions。
- Issue 需求必须小且清晰（低风险 / 低复杂度），确保能走自动通道：
  `S-NEW → S-PM_ANALYZING → S-RFC_DRAFT → S-RFC_READY → S-DEVELOPING → S-QA → S-REVIEW → S-PR_OPEN → S-DONE`。
- 仓库 CI 必须真实可跑（`node --test`），且能被 keel 的 `--ci real` 读取。

### R6 流程可回放

- `pnpm run timeline -- <task_id>` 能完整重建本次 task 的事件流。
- 控制台同一条 task 的详情与 timeline 一致。

## 非目标

- 不做写操作控制台（暂停 / 接管 / 重跑）—— 后续任务。
- 不做鉴权 / 多用户 —— 本地只读面板。
- 不改变 keel 的三平面边界与现有 CLI 行为。

## Acceptance Criteria

- [x] **AC1** `pnpm run console` 启动后，`http://127.0.0.1:4321/` 能列出 `keel_dev` 中现有全部 task。
- [x] **AC2** 点击任一 task，页面显示的状态 / run / 事件与 `keel status <id>`、
      `pnpm run timeline -- <id>` 的输出一致。
- [x] **AC3** 控制台代码中不存在 `INSERT` / `UPDATE` / `DELETE`，且数据库访问限定在
      `asRole('keel_control')` 只读路径（代码审查 + `pnpm run check` 通过）。
- [x] **AC4** `README.md` 增加控制台用法（启动命令、端口、只读说明）。
- [x] **AC5** `jionpz/keel-demo-app` 仓库存在，包含 demo 应用与 Actions workflow，
      首次 push 的 CI 为绿。
- [x] **AC6** `keel run-issue <真实 issue URL> --ci real --harness claude` 跑到 `S-DONE`，
      并产生真实 PR，PR 的 CI check 回读为 `passed`。
- [x] **AC7** 该 task 的 timeline 连续可读，且包含真实的 `CreatePullRequest` 副作用
      与 `CIPassed` 转移（不是 `SideEffectIntent` 占位）。
- [x] **AC8** 控制台能打开该 task 并看到完整的 run 与事件流。

## 证据（2026-10-27）

| 项 | 值 |
|---|---|
| task | `ab3d9159-fe98-4a0a-9347-35e57140a760`（S-DONE） |
| feedback | `f1b1ecdd-f676-4acd-9968-5e65865b4b36`（GitHub Issue `jionpz/keel-demo-app#1`） |
| PR | https://github.com/jionpz/keel-demo-app/pull/2 |
| CI | `gh pr checks 2` → 2 个 `test` 均 `pass` |
| 事件 | seq 110–146；`SideEffectApplied(CreatePullRequest)` 在 #143，`CIPassed → S-DONE` 在 #146 |
| develop diff | `WorkspaceDiffCollected` 记录 7627 字符 patch（app.js / index.html / style.css / todos.js / todos.test.mjs） |
| 控制台 | 8 个任务可见；新 task 的 pipeline / runs / 产物 / 事件均正常渲染 |
| 测试 | `pnpm run check` 全绿（467 passed / 5 skipped）；demo 仓库 `npm test` 15 passed |


## 备注

- 复杂任务：`design.md` + `implement.md` 为必需产物。
- 真实模型调用有非确定性；若 AC6 失败，记录失败证据与下一步，不伪报成功。
