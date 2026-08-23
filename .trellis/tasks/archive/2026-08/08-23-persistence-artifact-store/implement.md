# Implement — 持久化层与 ArtifactStore

> 顺序原则同骨架任务：**先建强制机制，再写被它约束的代码。**
> 授权先于 `ArtifactStore` 实现 —— 否则实现写完才加授权，
> 一定会先看到一堆权限报错，然后倾向于放宽授权。

---

## Stage 0 · 环境确认

- [ ] 0.1 确认连接用户是否 superuser、能否 `CREATE ROLE`
- [ ] 0.2 建 `keel_dev` / `keel_test` 两个数据库
- [ ] 0.3 **实测 `SET ROLE` 是否真的降权**（design.md §3.3 的风险项）
      —— 先手工验证，不要等写完实现才发现方案不成立

**门禁**：0.3 不成立则改用独立角色连接，并回改 `design.md`。

---

## Stage 1 · 迁移机制

- [ ] 1.1 装 `pg` `@types/pg` `node-pg-migrate`
- [ ] 1.2 迁移目录与配置；确认其 CLI 在 ESM 项目下可用
- [ ] 1.3 npm scripts：`db:create` / `db:migrate` / `db:reset`
- [ ] 1.4 写 `ADR-0007` 记录迁移工具选型（PRD Q1）

**验收**：空库上跑迁移成功；重复跑幂等。

---

## Stage 2 · 角色与授权 `[核心]`

**先于建表** —— 表建好后统一 GRANT，但角色要先存在。

- [ ] 2.1 `DO $$ ... $$` 幂等创建 `keel_control` / `keel_execution`（`NOLOGIN`）
- [ ] 2.2 `GRANT <role> TO CURRENT_USER`，使 `SET ROLE` 可用
- [ ] 2.3 撤销 `PUBLIC` 在 schema 上的默认权限，避免意外放行

---

## Stage 3 · Schema

- [ ] 3.1 `repo` `feedback` `task` `task_feedback` `run` `artifact` `event` 七张表
- [ ] 3.2 **`artifact.committed_at_seq`**（design.md §2 发现的缺口）
- [ ] 3.3 约束：`task.status` 的 15 值 `CHECK`、各 `UNIQUE`、外键
- [ ] 3.4 `I8` 触发器：终态 Task 禁止 UPDATE
- [ ] 3.5 索引（`docs/03-domain-model.md` §5）
- [ ] 3.6 **按矩阵 GRANT**（`docs/03-domain-model.md` §4）
- [ ] 3.7 `SECURITY DEFINER` 函数 `keel_commit_artifact(...)`：
      在函数内完成「插入新版 + 回填旧版 `superseded_by`」，
      使调用者无需 UPDATE 权限（design.md §4）
- [ ] 3.8 **同步 `docs/03-domain-model.md` §2.6**，补 `committed_at_seq` 列及其理由

---

## Stage 4 · 不变量反例验证 `[本任务的核心验收]`

**先写这些测试，再写 `ArtifactStore`。**
它们只依赖 schema 与授权，不依赖实现 —— 因此可以先跑起来。

- [ ] 4.1 测试基建：连接、`SET ROLE` 辅助、`TRUNCATE` 清理
- [ ] 4.2 `I1` `keel_control` UPDATE / DELETE `event` → 被拒
- [ ] 4.3 `I2` UPDATE / DELETE `artifact` → 被拒
- [ ] 4.4 `I5` **`keel_execution` INSERT `artifact`** → 被拒
- [ ] 4.5 `I5` `keel_execution` INSERT `event` → 被拒
- [ ] 4.6 `I5` `keel_execution` SELECT `task` / `feedback` → 被拒
- [ ] 4.7 `I6` UPDATE `feedback` → 被拒
- [ ] 4.8 `I8` UPDATE 已终结 `task` → 触发器异常
- [ ] 4.9 `I3` 重复 `idempotency_key` → 唯一冲突

**规则**：测试不通过时**改授权，不改测试**。

---

## Stage 5 · schema 漂移检查

- [ ] 5.1 从 `information_schema` 读实际列与类型
- [ ] 5.2 与 TS 行类型比对，不一致则失败
- [ ] 5.3 `task.status` 的 `CHECK` 取值与 `src/shared/ids.ts` 的 15 个状态比对
- [ ] 5.4 **防假绿**：读到 0 张表即报错

---

## Stage 6 · blob 存储

- [ ] 6.1 内容寻址实现：`put(bytes) -> hash` / `get(hash) -> bytes` / `has(hash)`
- [ ] 6.2 路径分片 `blob/<h[0:2]>/<h[2:]>`
- [ ] 6.3 测试：同内容只存一份；读回一致

---

## Stage 7 · `ArtifactStore` 实现

- [ ] 7.1 `appendEvent` / `readEvents`
- [ ] 7.2 `commit`：
      - 两项硬检查（`supersedes` 是最新版、版本未占用）→ 违反返 `CONFLICT`
      - blob 阈值切分（**先写 blob 后写 artifact**）
      - 同一事务：写 event → 拿 `seq` → 调 `keel_commit_artifact`
- [ ] 7.3 `get` / `latest` / `history`
- [ ] 7.4 `getAsOf`（依赖 `committed_at_seq`）
- [ ] 7.5 测试：
      - 版本链与 `superseded_by` 正确
      - `CONFLICT` 场景
      - **事务性：中途失败则 artifact 与 event 都不落盘**
      - `getAsOf` 返回的是「那一刻」的版本而非最新版

---

## Stage 8 · CI

- [ ] 8.1 GitHub Actions 加 `services: postgres`
- [ ] 8.2 CI 中跑迁移后再跑 `pnpm run check`
- [ ] 8.3 确认骨架的四条约束检查仍为绿，**未被放宽**

---

## Stage 9 · 收口

- [ ] 9.1 `docs/` 同步（至少 `03-domain-model.md` §2.6 的新列）
- [ ] 9.2 `ADR-0007` 定稿
- [ ] 9.3 `.trellis/spec/backend/database-guidelines.md` —— **现在有真实代码可写了**
- [ ] 9.4 逐条勾 `prd.md` 验收
- [ ] 9.5 commit

---

## 回滚点

| 时机 | 方式 |
|---|---|
| Stage 0.3 `SET ROLE` 方案不成立 | 改独立角色连接，回改 `design.md` §3.3 |
| Stage 1 迁移工具与 ESM 冲突 | 回退自研 runner，记入 `ADR-0007` |
| Stage 4 某条不变量无法在 DB 层强制 | **不删测试** —— 在 `prd.md` 如实记录该不变量未被机制化，并说明退路 |
