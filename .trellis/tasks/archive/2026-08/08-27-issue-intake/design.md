# Issue Intake — 技术设计

与父任务 `design.md` §2.1–§2.4、§6 一致。本 child 只交付 intake 段。

## 核心

- `driver.intake()` 平行入口（不改 `transition()` 对 from:null 的语义）
- 方案 A：intake 内直接实现 CreateTask/LinkFeedback；effects.ts 这两 case 改抛错
- 迁移 `1000000000003_github_ingress.sql` + `KeelRole` 加 `keel_ingress`
- CLI：`ingest-issue.ts`、`register-repo.ts`

详见父 `.trellis/tasks/08-27-github-issue-automation/design.md`。
