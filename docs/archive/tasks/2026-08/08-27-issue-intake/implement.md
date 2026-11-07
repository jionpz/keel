# Issue Intake — 执行计划

父任务 implement.md Phase 1（步骤 1–4）。按序执行：

1. 迁移 + db.ts + invariants 反例 + docs/03 更新 → `db:migrate` / `db:reset` 验证
2. GitHubProvider.getIssue + parseIssueUrl + 单测
3. driver.intake + effects CreateTask/LinkFeedback 真实化 + driver/effects 测试
4. register-repo + ingest-issue CLI + index/help + cli.test + 集成测试（AC4）

验证：`pnpm run check` 全绿。

禁止：git commit。完成后报告修改文件与验证结果。

---

## 完成状态（check 2026-08-27）

- [x] 步骤 1 迁移 + db.ts + invariants 反例 + docs/03
- [x] 步骤 2 getIssue + parseIssueUrl + 单测
- [x] 步骤 3 driver.intake + effects CreateTask 真实化
- [x] 步骤 4 register-repo + ingest-issue CLI + index/help + 集成测试

`pnpm run check` 全绿：269 passed / 4 skipped。

### 与 design 的两处**刻意**偏离（不要「修正」回去）

1. **effects.ts 只让 `CreateTask` 抛错，`LinkFeedback` 保持 recordIntent。**
   design §2.1 写的是「这两个 case 改为抛错」，但 `LinkFeedback` 也出现在 T-007
   （澄清回灌，`table.ts:102`），那条路径确实经 `applyEffects`。让它抛错会打断 T-007。
2. **`register-repo` 以 `asOwner` 写入。**
   docs/03 §4 矩阵里三个运行时角色对 `repo` 都只有 SELECT —— 仓库注册是管理操作，
   没有对应角色。给 `keel_ingress` 授 `repo` INSERT 等于让外部输入自选目标仓库。
   矩阵已补一段说明作为依据。

### 反例验证记录

| 新增检查 | 制造的违规 | 结果 |
|---|---|---|
| driver.ts 的 T-001 表行断言 | 交换 `table.ts` 里 T-001 的 effects 顺序 | driver.test.ts 红（import 期抛错） |
| cli.test.ts 的 switch/HELP 漂移检查 | 加一个未写进 HELP 的 `case 'undocumented-probe'` | 红并指出该命令 |
| 迁移 down 段 | 在事务内跑 down 后 ROLLBACK | REVOKE/CHECK 还原均成功执行 |
