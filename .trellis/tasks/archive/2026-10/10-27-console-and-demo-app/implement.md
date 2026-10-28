# 执行计划 · keel 控制台 + demo APP 全流程演练

## 阶段 A · 只读控制台

- [ ] A1 新增 `src/cli/console.ts`：`node:http` 服务 + 只读查询
      （`/`、`/api/tasks`、`/api/tasks/:id`、`/healthz`），绑定 `127.0.0.1:4321`。
- [ ] A2 新增 `src/cli/console-page.ts`：单文件 HTML（列表 / 详情 / 状态机条 / 时间线 / 自动刷新）。
- [ ] A3 `package.json` 增加 `"console": "tsx src/cli/console.ts"`；`dist` 构建自动覆盖。
- [ ] A4 `README.md` 增加「控制台」小节（启动、端口、只读说明）。
- [ ] A5 （可选）`.claude/launch.json` 增加 `console` 配置，便于在桌面 App 预览。

**验证（Gate A）**
```bash
pnpm run lint && pnpm run typecheck && pnpm run boundaries
pnpm run console &
curl -s http://127.0.0.1:4321/api/tasks | head
curl -s http://127.0.0.1:4321/api/tasks/1d891a16-be91-4763-8333-38edd182a824 | head
pnpm run timeline -- 1d891a16-be91-4763-8333-38edd182a824
```
- 页面展示的 run / 事件必须与 `keel status`、`timeline` 一致。
- 代码审查：无 INSERT / UPDATE / DELETE；无新依赖。

## 阶段 B · demo APP 仓库

- [ ] B1 本地创建 `/Users/jionpz/mycode/keel-demo-app`：`public/`、`src/todos.js`、
      `test/todos.test.mjs`、`server.mjs`、`package.json`、`README.md`、`.github/workflows/ci.yml`。
- [ ] B2 本地验证：`npm test` 绿；`npm start` 能打开页面。
- [ ] B3 `gh repo create jionpz/keel-demo-app --public --source . --push`。

**验证（Gate B）**
```bash
gh run list --repo jionpz/keel-demo-app --limit 3
gh repo view jionpz/keel-demo-app --json visibility,defaultBranchRef
```
- 首次 Actions 必须为 `success`；否则先修 CI，不进入 C。

## 阶段 C · 真实闭环

- [ ] C1 `gh issue create` 建需求 Issue（状态筛选 + 剩余计数，含验收标准）。
- [ ] C2 `keel register-repo <url> --default-branch main`（幂等，已注册则复用）。
- [ ] C3 启动控制台，另开进程执行：
      `KEEL_GITHUB_TOKEN="$(gh auth token)" node dist/cli/index.js run-issue <issue-url> --ci real --harness claude --wall-clock 1800`
- [ ] C4 记录终态、task_id、PR URL、CI 结果。
- [ ] C5 `pnpm run timeline -- <task_id>` 导出完整事件流并核对 T-021 / T-024 为真实副作用。

**验证（Gate C）**
```bash
gh pr list --repo jionpz/keel-demo-app --state all
gh pr checks <pr-number> --repo jionpz/keel-demo-app
node dist/cli/index.js status <task_id> --events 10
pnpm run timeline -- <task_id>
```
- AC6 以「PR 的 CI 回读 passed」为准，不以 CLI 自报为准。

## 阶段 D · 收口

- [ ] D1 `pnpm run check` 全绿。
- [ ] D2 更新本任务 `prd.md` 勾选 AC 与证据（task_id / PR / CI）。
- [ ] D3 按需更新 `.trellis/spec/frontend/index.md`（出现真实前端代码后不再是空壳）。
- [ ] D4 提交（仅 keel 仓库内的改动；demo 仓库独立提交）。

## 回滚点

| 点 | 回滚方式 |
|---|---|
| A 后不满意 | 删除 `console.ts` / `console-page.ts` / script / README 段落 |
| B 后 CI 红 | 修 workflow 或 `npm test`，不 push 脏状态给 keel |
| C 停在非 S-DONE | 保留证据，按 PRD 备注记录；新建 task 重跑，不伪报 |
| demo 仓库不要了 | `gh repo delete jionpz/keel-demo-app`（需用户明确确认） |

## 备注

- 真实模型调用有非确定性；`--wall-clock 1800` 只抬高上限，不改判据。
- 不在 CI 里跑验收（沿用现有纪律）。
