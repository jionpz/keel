# CLI 入口:keel worker/run/status

## Goal

给 Keel 一个可用的命令行入口,接线现有 loop/worker/db。最小三命令:
- `keel timer-worker [--interval <ms>]` — 到期收割(单次或常驻,接线 drainAllDueTimers/runForever)
- `keel run-task <taskId>` — 驱动单 task 到终态(接线 runTaskToCompletion)
- `keel status <taskId>` — 查 task/run/事件摘要

## Background

- 现有:`scripts/timer-worker.ts`(tsx 跑,仅 drain)+ loop/wtooth 全在库内(`runTaskToCompletion` / `drainAllDueTimers` / `runForever`)。
- 无 bin、无 CLI 依赖。ESM + tsc build 已有(tsconfig.build.json → dist/)。
- DB 连接:`connectionString()` 默认 `postgres://localhost/keel_dev`。

## Requirements

### R1 · CLI 框架

- `src/cli/index.ts`:arg 解析(无第三方依赖 —— 手写 argv 解析,保持零依赖)。
- package.json:`"bin": {"keel": "./dist/cli/index.js"}`,`"build"` 已产出 dist。
- 子命令:`timer-worker` / `run-task` / `status`;`--help` / `--version`。

### R2 · timer-worker

- 接线 `drainAllDueTimers`(单次)+ `runForever`(--interval 常驻,SIGTERM 退出)。
- 默认单次(替换现有 scripts/timer-worker.ts 功能)。`scripts/timer-worker.ts` 保留或指向 CLI?**决策**:删除 scripts 示例,统一进 CLI(避免双入口)。

### R3 · run-task

- 接线 `runTaskToCompletion(taskId, deps, opts)`:
  - deps:driver(WorkflowDriver)+ sessions + adapter(OmpAdapter)+ workspace(worktree 需 repo_id/branch?单 task 用 fixed 或从 task 表读 repo)。
  - **难点**:runTaskToCompletion 需要 WorkspaceBinding(git/repoId)—— CLI 需从 DB 读 task 的 repo_id + git workspace 根。设计:temporary git 根(每进程 mkdtemp)+ 读 task.repo_id → ensureBareRepo(remote_url)→ worktree。
  - opts:`--max-steps`、`--external-ci passed|failed`(缺省注入 passed,验收用)。
- 输出:终态 + step 轨迹。

### R4 · status

- 查 task:status/control_mode/created/updated;
- 查 run:各 stage/attempt/status/error_kind;
- 查事件:最近 N 条(type/seq/payload 摘要)。
- 纯只读(asRole keel_control)。

### R5 · 回归

- CLI 单测:`--help`、未知命令退出码非 0、argv 解析;
- timer-worker 单测(已有 drain e2e);CLI 包装薄,核心逻辑已测——CLI 层只测解析与接线。
- `pnpm run check` 全绿(CLI 文件进 typecheck;不要把 CLI 跑进默认 test)。

## Acceptance Criteria

- [ ] R1:keel bin + 三子命令;`--help`/`--version`;
- [ ] R2:timer-worker 单次/常驻;scripts 统一进 CLI;
- [ ] R3:run-task 驱动单 task(固定/临时 git 根)→ 终态 + steps;
- [ ] R4:status 查 task/run/事件摘要;
- [ ] R5:CLI 单测(解析/退出码);`pnpm run check` 全绿。

## Constraints

- **零第三方 CLI 依赖**(手写解析)—— 保持项目最小化。
- run-task 的 workspace 用临时 git 根(不持久化,单次执行);worktree 模式(real 编排路径)。
- status 只读。
- 不引入 daemon 监督(worker 常驻循环 + SIGTERM 已够;监督属接入层)。

## Notes

- 复杂任务边界:CLI 是薄壳,核心(loop/worker/reap)已测;风险在 run-task 的 workspace 组装。
- build 后 bin 生效;开发期 `pnpm tsx src/cli/index.ts ...` 直接跑。