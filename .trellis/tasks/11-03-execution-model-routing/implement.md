# 执行面模型路由 — 实施计划

## 顺序

1. **路由纯逻辑**
   - [x] 新建 `src/execution/model-routing.ts`（profile / 阶段表 / 解析 / allowlist）
   - [x] `omp.ts` 的 `DEFAULT_OMP_MODEL` 改为 re-export
   - [x] 单测：优先级、非法 profile、allowlist

2. **契约与 adapter**
   - [x] `RunSpec` 增加可选 `model`
   - [x] `buildArgv` 优先 `spec.model`
   - [x] `OmpAdapter` 不因缺少 spec.model 改变现有行为
   - [x] claude adapter 忽略 `spec.model`（保持不传 `--model`）

3. **编排器与落库**
   - [x] `OrchestratorDeps` 增加 `modelProfile` / `modelAllowlist` / `modelOverride`
   - [x] `executeClaimedRun` 解析并写入 `runSpec.model`
   - [x] 迁移 `1000000000008_run_requested_model.sql`（`0007` 已被 run_liveness 占用）
   - [x] 认领后 `UPDATE run SET requested_model`
   - [x] 解析失败走 `failRunAndAdvance`，不 spawn

4. **CLI**
   - [x] `run-task` / `run-issue` / `poller` 启动时解析 `KEEL_MODEL_PROFILE` / `KEEL_MODEL_ALLOWLIST`
   - [x] 非法值报错退出（不进入驱动）
   - [x] 帮助文本 + README 补充变量说明

5. **测试**
   - [x] `resolveStageModel` 表驱动
   - [x] `buildArgv` 覆盖
   - [x] 编排器测试：`requested_model` 与 stub 收到的模型一致
   - [x] enterprise profile 下 develop ≠ pm

6. **验收**
   - [x] `pnpm run check`
   - [x] `pnpm run db:migrate` 在测试库可重复执行
   - [x] 不设新变量时 `--model` 行为与改动前一致

## 验证记录

- `pnpm run check`：57 文件 / **827 passed | 5 skipped**（5 个 skip 为原有真实集成用例）。
- `pnpm vitest run src/execution/model-routing.test.ts src/control/orchestrator/model-routing.test.ts src/execution/adapters/adapters.test.ts`：
  3 文件 / 78 passed | 4 skipped。
- 迁移：`node-pg-migrate up` 连续执行两次，第二次 `No migrations to run!`；
  `information_schema` 确认 `run.requested_model text NULL`。
- 检查阶段修了两处：allowlist 启动期预检（原先要等认领后才失败，`run-issue` / `poller`
  已先 ingest）、`run-task` 双重解析模型。均有反例测试钉住。
- 残留（如实记录）：程序化直接调 `runTaskToCompletion` 时，`modelOverride` 与 claude
  adapter 构造参数仍由调用方分别传入，契约层面无法强制一致；CLI 路径两者同源。
- 契约沉淀：`.trellis/spec/backend/model-routing.md`。

## 验证命令

```bash
pnpm run check
pnpm vitest run src/execution/model-routing.test.ts src/control/orchestrator/model-routing.test.ts src/execution/adapters/adapters.test.ts
```

## 审阅门

- 阶段表只允许一处定义。
- `requested_model` 的写值必须与 `spec.model` 同源，不允许两处各算一次。
- 不允许把企业网关地址/密钥写进代码或默认值。

## 回滚点

- 第 1 步纯新增，可独立提交。
- 第 3 步含迁移；回滚需 `DROP COLUMN`，单独一个 commit 便于操作。
