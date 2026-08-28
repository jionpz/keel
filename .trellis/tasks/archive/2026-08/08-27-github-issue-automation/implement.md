# GitHub Issue 自动构建 — 执行计划

前置：`prd.md`（需求/验收）、`design.md`（技术方案）、`research/evidence-audit.md`（证据锚点）。

本任务建议按父子结构执行：本目录为父任务，实施在两个子任务中进行
（`issue-intake` → `run-issue-e2e`；`issue-poll-daemon` 暂缓不建）。
以下清单按子任务分组；若最终不拆子任务，则按顺序整体执行。

## Phase 1 — issue-intake

### 1. 迁移与角色

- [ ] 新建 `migrations/1000000000003_github_ingress.sql`：
  - feedback.source CHECK 加 `github`（先 `\d feedback` 实测约束名再 DROP/ADD）
  - `keel_ingress` 角色（NOLOGIN + GRANT 给 CURRENT_USER，写法同初始迁移 DO 块）
  - `GRANT USAGE ON SCHEMA public` + `GRANT SELECT, INSERT ON feedback TO keel_ingress`
  - Down migration：还原 CHECK、REVOKE（角色留存）
- [ ] `src/fact/db.ts`：`KeelRole` 加 `'keel_ingress'`
- [ ] `src/fact/invariants.test.ts` 补授权反例：ingress 不能写 task/artifact/event；
      control 仍不能 INSERT feedback
- [ ] docs/03-domain-model.md §4 矩阵注明 Ingress = keel_ingress；§1 feedback.source 枚举更新
- 验证：`pnpm run db:migrate && pnpm run db:reset && pnpm run db:migrate`（up/down 都过）

### 2. GitHubProvider.getIssue

- [ ] `src/fact/github-provider.ts`：`IssueInfo` + `getIssue()` + `parseIssueUrl()`
      （复用 request()/ownerRepo，见 design §2.3）
- [ ] `src/fact/github-provider.test.ts` 补 stub HTTP 用例：正常 issue、带
      pull_request 字段排除、body=null、closed state、label 列表
- 验证：`pnpm run test -- github-provider`

### 3. T-001 真实化（intake 入口）

- [ ] `src/control/driver/driver.ts`：新增 `intake(input, now)`（design §2.1 方案 A：
      单 keel_control 事务；幂等查 task_feedback；work_branch 用 `branchFor`；
      SideEffectApplied ×2 + TaskStatusChanged{T-001}）
- [ ] `src/control/driver/effects.ts`：CreateTask/LinkFeedback 移出 recordIntent，
      改为抛错指向 intake 路径；注释同步（「v0.1 只记录意图」列表缩减）
- [ ] `src/control/driver/driver.test.ts` / `effects.test.ts`：intake 建 task 断言
      （状态/分支名/事件序）、重复 intake 幂等、事务原子性（中途失败无半建 task）
- ⚠️ 风险文件：`effects.ts` 改 switch 分支时不得触碰其他 effect 语义；
      `check:transitions`（C4）必须保持绿 —— 转移表本身零改动
- 验证：`pnpm run check`

### 4. CLI：ingest-issue / register-repo

- [ ] `src/cli/register-repo.ts`：幂等注册（按 remote_url 查重），asOwner 或管理员连接
- [ ] `src/cli/ingest-issue.ts`：URL 解析 → repo 解析（归一化 .git/尾斜杠）→
      getIssue → 闸门（open / 非 PR / label，缺省 `keel`）→ keel_ingress 落 feedback
      （ON CONFLICT 复用）→ driver.intake → 打印 taskId
- [ ] `src/cli/index.ts` 注册两个子命令 + HELP 更新；`src/cli/cli.test.ts` 补用例
- [ ] 集成测试：ingest（stub HTTP）→ task S-NEW → 复用既有 loop 测试设施驱动一步
      （AC4：无 seed SQL 衔接）
- 验证：`pnpm run check`；手动 `keel ingest-issue <真实 URL>`（需 token）

## Phase 2 — run-issue-e2e（依赖 Phase 1 全部完成）

### 5. run-task 真实模式

- [ ] `src/cli/run-task.ts`：`--ci real` → 构造 GitHubProvider，传 WorkflowDriver 第三参
      + `opts.ci`；无 token 时启动即报错；`--ci passed|failed` 路径与缺省值不变
- [ ] `src/control/orchestrator/ci-wiring.test.ts` 或新测试：real 模式接线断言
      （driver 收到 gateway、loop 收到 ci）
- 验证：`pnpm run check`

### 6. run-issue 组合命令

- [ ] 提取 ingest 与 run-task 的共享主体函数（不复制粘贴）
- [ ] `src/cli/run-issue.ts`：ingest → run → 从事件流读 pr_url 打印；
      非 S-DONE 终态如实报告（AC6），编排错误才非 0 退出
- [ ] `src/cli/index.ts` 注册 + HELP；cli.test.ts 补用例
- 验证：`pnpm run check`

### 7. 真实验收（opt-in）

- [ ] `src/acceptance/issue-e2e.acceptance.test.ts`：模式同 github-pr 验收
      （缺凭据明确失败不 skip）；API/gh 建带 label 的真实 Issue → run-issue --ci real →
      断言 S-DONE + PR + CI passed + transitions T-001 起 T-024 终；finally 收尾
      （关 PR、删 ai/* 分支、关 Issue）
- [ ] `src/acceptance/README.md` 补运行说明
- 验证：`KEEL_GITHUB_TOKEN=… KEEL_TEST_REMOTE_REPO=… pnpm run test:acceptance`

## 收尾检查（task.py start 前 → 完成后）

- [ ] `pnpm run check` 全绿（lint/typecheck/boundaries/generated/transitions/purity/test）
- [ ] up/down 迁移双向验证过
- [ ] 真实验收至少跑通一次（模型变差导致的失败按诚实纪律记录，不掩盖）
- [ ] spec 回写候选：keel_ingress 角色纪律 → `.trellis/spec/backend/database-guidelines.md`；
      intake 入口模式（from:null 转移的实现形态）→ 视沉淀价值决定

## 回滚点

- 迁移：`pnpm run db:reset`（down 已验证）
- 新 CLI 三文件 + provider 扩展：独立新增，整体 revert 不伤既有路径
- effects.ts / driver.ts：改动集中在 CreateTask/LinkFeedback 分支与新增 intake 方法，
  revert 后 recordIntent 行为恢复
