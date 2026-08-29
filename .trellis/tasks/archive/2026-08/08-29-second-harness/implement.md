# 第二个 AI Harness · 执行清单

调研：`research/claude-code-interface.md`（claude 2.1.222 `--help` 实测）。

## 顺序

1. [x] 本机 `--help` / `--version` / `auth status` → research 文件（stream 样本本会话未抓，parser 字段缺失则 null）
2. [x] `claude-code-parse.ts` 纯函数 + 文档形状 fixture（对标 `omp-parse.ts`）
3. [x] `claude-code.ts` Adapter：`buildClaudeArgv` 可单测；spawn/interrupt 抄 OMP 进程组，**不要**抽基类
4. [x] 注册 `adapters/index.ts`；capability / `tierOf` 测试
5. [x] `resolveHarness`：`--harness` > `KEEL_HARNESS` > `omp`；非法值 `CAPABILITY_UNSUPPORTED`，不静默回退
6. [x] `run-task` / `run-issue` 按 harness 构造 Adapter；claude **禁止**把缺省 `deepseek-v4-flash` 塞进 `--model`
7. [x] `preflightClaude`：`claude --version`；untrusted 路径缺 `ANTHROPIC_API_KEY` 明确失败（`--bare` 不读 OAuth）
8. [x] CLI 帮助三处（`index.ts` / `run-task.ts` / `run-issue.ts`）加 `--harness omp|claude`，防漂移
9. [x] opt-in `src/acceptance/claude-code-e2e.acceptance.test.ts`（对标 issue-e2e；`preflightClaude`+`preflightGitHub`；不 skip）
10. [x] `pnpm run check` 全绿

## 硬约束

- `workspace.untrusted` → argv **必须** `--bare`。省略 = 安全回退，禁止。
- `output_contract.mode=native` → 拒绝（本任务不接线 `--json-schema`）
- 不改 `docs/schemas/`、转移表、Policy 规则集
- 相对 import 带 `.js`；execution 不得 import fact
- Adapter 渲染 **全部** `context.sections`（session-context.md）
- 读完整个 stdout；stdin ignore；spawn `detached: true`
- 验收 / 缺二进制：**失败，不 skip**

## 验证

```bash
pnpm run check
# 真实验收（凭据：ANTHROPIC_API_KEY + KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO）
pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/claude-code-e2e.acceptance.test.ts
```

## Rollback

只回滚本 branch 的 adapter/CLI 文件；不改五连 / OMP 缺省路径。
