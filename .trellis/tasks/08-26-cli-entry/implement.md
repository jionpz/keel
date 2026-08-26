# CLI 入口 — 执行计划

## 批次

### 批次 1 — CLI 框架 + timer-worker

1. `src/cli/argv.ts`:parseArgs + 帮助文本。
2. `src/cli/index.ts`:命令分发 + bin shebang。
3. `src/cli/timer-worker.ts`:接线 drainAllDueTimers/runForever。
4. 删 `scripts/timer-worker.ts`。
5. package.json `"bin"` + `"keel-cli"` script?—— 保持 bin 即可。
6. 单测 `src/cli/cli.test.ts`(解析/帮助/未知命令)。
7. commit `(issue #27 C1)`。

### 批次 2 — run-task

1. `src/cli/run-task.ts`:读 task+repo → GitWorkspace(mkdtemp)→ ensureBareRepo → binding → runTaskToCompletion → 输出 steps。
2. 边界:task 不存在 → exit 1;repo remote 不可克隆 → 错误信息。
3. e2e 验证(真实 DB + fake OMP?或只验证到可组装):用手动 CLI 跑一个 seeded task。
4. commit `(issue #27 C2)`。

### 批次 3 — status

1. `src/cli/status.ts`:task/run/events 三查 + 摘要输出。
2. 单测(查询 SQL 正确性 —— 可纯函数化 makeStatusQueries)。
3. commit `(issue #27 C3)`。

### 批次 4 — 全量 + 文档 + 收尾

1. `pnpm run check` 全绿;`pnpm run build` 产出 dist(cli/bin 生效)。
2. README/roadmap:CLI 用法小节。
3. issue #27 记录;归档;journal + gbrain。

## 验证命令

```bash
pnpm run check
pnpm run build
pnpm tsx src/cli/index.ts --help
pnpm tsx src/cli/index.ts status <taskId>   # 需 DB seeded task
```

## 评审门

- run-task 的 workspace 组装(临时 git 根 + ensureBareRepo)与 merge 验收同模式,但那是测试;CLI 是产品入口 —— 失败信息要可读。
- dist 是否 gitignore:CLI bin 指向 dist,确认 build 必需。查 .gitignore 现状,C1 确认。

## 回滚

- 每批独立 commit;bin 加错可随时撤(fallback tsx)。