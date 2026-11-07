# CLI 入口 — 技术设计

## 目标

三命令薄壳,deps 全从库接线,零第三方依赖。

## 结构

```
src/cli/
  index.ts      # argv 解析 + 命令分发(bin 入口)
  worker.ts     # timer-worker 命令(接线 drainAllDueTimers/runForever)
  run-task.ts   # run-task 命令(接线 runTaskToCompletion)
  status.ts     # status 命令(DB 只读查询)
```

package.json:
```json
"bin": { "keel": "./dist/cli/index.js" }
```
tsconfig.build.json include src/** → dist/ 已覆盖 cli。构建后 `keel` 可用;开发 `pnpm tsx src/cli/index.ts ...`。

## argv 解析(零依赖手写)

```ts
// src/cli/index.ts
const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'timer-worker':   return workerMain(rest)   // --interval <ms>
  case 'run-task':       return runTaskMain(rest)  // <taskId> [--max-steps N] [--ci passed|failed]
  case 'status':         return statusMain(rest)   // <taskId> [--events N]
  case '--help': case '-h': case '--version': ...
  default:               console.error(`未知命令:${cmd}`); process.exit(2)
}
```

解析 helper `parseArgs(rest, {string: ['interval','max-steps','ci'], boolean: ['once']})` → `{ positionals, flags }`。

## timer-worker

```ts
const deps = { driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)), now: () => new Date().toISOString() }
if (flags.interval) await runForever(deps, { intervalMs })
else { const s = await drainAllDueTimers(deps); console.log(JSON.stringify(s)) }
```

删除 `scripts/timer-worker.ts`(功能并入 CLI)。

## run-task(难点:workspace 组装)

`runTaskToCompletion(taskId, deps, opts)` 需要:
- driver(workspace binding 可选:driver 的 CreateBranch/CleanWorkspace 在未绑定时记录意图;**real run 需 binding**);
- workspace: `{ mode:'worktree', git, repoId, baseBranch }`。

CLI 组装:
1. 读 task(DB):`repo_id, base_branch`。
2. 读 repo(DB):`remote_url`。
3. `git = new GitWorkspace({ root: mkdtempSync(...) })`;`ensureBareRepo(repoId, remote_url)`。
4. binding = `{ git, repoId, baseBranch }`;deps.workspace = `{ mode:'worktree', ...binding }`。
5. opts.ci:`--ci passed` → `externalCi: async () => 'passed'`(或 future 真 GitHubProvider)。
6. 输出:`finalStatus` + steps(transition 轨迹)。

边界:task 是 S-NEW(无人干预敞开开始)或已进行(续跑)。两者 runTaskToCompletion 都能推(读当前状态继续)。

## status

DB 只读(keel_control):
- task:`SELECT status, control_mode, created_at, updated_at, terminal_at FROM task WHERE id=$1`
- run:`SELECT stage, attempt, status, error_kind, ended_at FROM run WHERE task_id=$1 ORDER BY attempt`
- events:`SELECT seq, type, payload FROM event WHERE task_id=$1 ORDER BY seq DESC LIMIT $N`(N 缺省 20,摘要 JSON)

## 测试

- `src/cli/cli.test.ts`(纯函数层,不 spawn 进程):
  - argv 解析(timer-worker --interval / run-task id --max-steps / status id --events);
  - 未知命令 → exit 2;
  - --help/--version 输出。
- timer-worker 逻辑已由 drain e2e 覆盖;CLI 薄壳只测解析。
- run-task/status 不连 DB 单测(接线逻辑简单;DB 路径由既有 e2e 覆盖 loop)。

## 不做

- 不引入 commander/yargs(零依赖原则)。
- 不做 daemon 监督(worker 交给用户/未来接入层)。
- 不把 CLI 跑进默认 check(独立命令,需 DB/真实环境)。

## 风险

- run-task 的 workspace:临时 git 根 + ensureBareRepo(真实 remote)→ 若 task.repo.remote_url 是 https 需凭据(未来);v0.1 验收类任务已有此经验(merge 验收)。
- build 产物 dist 是否 gitignore?查(.gitignore)——bin 指向 dist,需确认构建流程。