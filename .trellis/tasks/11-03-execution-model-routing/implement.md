# 执行面模型路由 — 实施计划

## 顺序

1. **路由纯逻辑**
   - [ ] 新建 `src/execution/model-routing.ts`（profile / 阶段表 / 解析 / allowlist）
   - [ ] `omp.ts` 的 `DEFAULT_OMP_MODEL` 改为 re-export
   - [ ] 单测：优先级、非法 profile、allowlist

2. **契约与 adapter**
   - [ ] `RunSpec` 增加可选 `model`
   - [ ] `buildArgv` 优先 `spec.model`
   - [ ] `OmpAdapter` 不因缺少 spec.model 改变现有行为
   - [ ] claude adapter 忽略 `spec.model`（保持不传 `--model`）

3. **编排器与落库**
   - [ ] `OrchestratorDeps` 增加 `modelProfile` / `modelAllowlist` / `modelOverride`
   - [ ] `executeClaimedRun` 解析并写入 `runSpec.model`
   - [ ] 迁移 `1000000000008_run_requested_model.sql`（`0007` 已被 run_liveness 占用）
   - [ ] 认领后 `UPDATE run SET requested_model`
   - [ ] 解析失败走 `failRunAndAdvance`，不 spawn

4. **CLI**
   - [ ] `run-task` / `run-issue` 启动时解析 `KEEL_MODEL_PROFILE` / `KEEL_MODEL_ALLOWLIST`
   - [ ] 非法值报错退出（不进入驱动）
   - [ ] 帮助文本 + README 补充变量说明

5. **测试**
   - [ ] `resolveStageModel` 表驱动
   - [ ] `buildArgv` 覆盖
   - [ ] 编排器测试：`requested_model` 与 stub 收到的模型一致
   - [ ] enterprise profile 下 develop ≠ pm

6. **验收**
   - [ ] `pnpm run check`
   - [ ] `pnpm run db:migrate` 在测试库可重复执行
   - [ ] 不设新变量时 `--model` 行为与改动前一致

## 验证命令

```bash
pnpm run check
pnpm vitest run src/execution/model-routing.test.ts src/execution/adapters/omp.test.ts
```

## 审阅门

- 阶段表只允许一处定义。
- `requested_model` 的写值必须与 `spec.model` 同源，不允许两处各算一次。
- 不允许把企业网关地址/密钥写进代码或默认值。

## 回滚点

- 第 1 步纯新增，可独立提交。
- 第 3 步含迁移；回滚需 `DROP COLUMN`，单独一个 commit 便于操作。
