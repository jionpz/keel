# 执行面模型路由 — 技术设计

## 1. 模块

新建 `src/execution/model-routing.ts`：

```ts
export type ModelProfile = 'default' | 'enterprise'

export const DEFAULT_OMP_MODEL = 'deepseek-v4-flash'   // 从 omp.ts 迁来并 re-export

export const ENTERPRISE_STAGE_MODELS: Readonly<Record<Stage, string>> = {
  pm: 'zai-org/GLM-5.3',
  brainstorm: 'zai-org/GLM-5.3',
  critic: 'zai-org/GLM-5.3',
  rfc_draft: 'zai-org/GLM-5.3',
  develop: 'moonshotai/Kimi-K3',
  qa: 'moonshotai/Kimi-K3',
  review: 'moonshotai/Kimi-K3',
}

export function parseProfile(raw: string | undefined): Result<ModelProfile>
export function resolveStageModel(input: {
  stage: Stage
  cliModel?: string
  envModel?: string
  profile: ModelProfile
  allowlist?: readonly string[]
}): Result<string>
```

优先级：`cliModel > envModel > profile 表 > DEFAULT_OMP_MODEL`。
`allowlist` 非空时，最终值必须命中，否则 `CAPABILITY_UNSUPPORTED`。

`omp.ts` 的 `DEFAULT_OMP_MODEL` 改为从这里 re-export，避免第二份定义。

## 2. 模型如何进入一次 run

### 2.1 契约扩展

`RunSpec` 增加可选字段：

```ts
/** 本次 run 的模型覆盖。omp 会用它替换构造时的缺省；claude 忽略 */
readonly model?: string
```

`buildArgv(spec, fallbackModel)`：

```ts
const model = spec.model ?? fallbackModel
const argv = ['-p', '--mode=json', '--model', model]
```

这是最小改动：adapter 无需知道 profile，编排器只传递最终值。

### 2.2 编排器

`executeClaimedRun` 在构造 `runSpec` 前解析：

```ts
const requestedModel = resolveStageModel({
  stage: pending.stage,
  cliModel: deps.modelOverride,       // run-task --model 已解析后的值
  envModel: undefined,                 // resolveModelForHarness 已合并
  profile: deps.modelProfile,
  allowlist: deps.modelAllowlist,
})
```

- `OrchestratorDeps` 增加 `modelProfile` 与 `modelAllowlist`（缺省 `default` / `[]`）。
- 同一个 `requestedModel` 同时用于：
  1. `runSpec.model`；
  2. `UPDATE run SET requested_model = $1 WHERE id = $2`（认领后、spawn 前）。
- 解析失败 → `failRunAndAdvance`，不 spawn。

> 由于 `run-task.ts` 已经把 `--model` / `KEEL_MODEL` 解析成 `deps.adapter` 的模型，
> 为保持单一来源，`run-task.ts` 不再把全局模型传给 adapter 构造函数；
> 改为传给编排器的 `modelOverride`，由 `resolveStageModel` 统一裁决。
> 若调用方显式传了 `--model`，它对所有阶段生效（`cliModel` 最高优先级）。

### 2.3 数据库

新增迁移 `1000000000006_run_requested_model.sql`：

```sql
ALTER TABLE run ADD COLUMN requested_model text;
```

- 可空；旧行为 NULL。
- 不加入写权限矩阵的特殊限制（`keel_control` 已可 UPDATE run 的既有状态字段）。

## 3. CLI / 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `KEEL_MODEL` | 全局模型覆盖（已有） | 未设 |
| `KEEL_MODEL_PROFILE` | `default` / `enterprise` | `default` |
| `KEEL_MODEL_ALLOWLIST` | 逗号分隔的允许模型 | 未设（不校验） |

`run-task` / `run-issue` 的帮助文本补充这三个变量的说明。
非法 `KEEL_MODEL_PROFILE` → 启动即报错退出，不进入驱动。

## 4. 兼容性

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 未设新变量、未设 `KEEL_MODEL` | deepseek-v4-flash | 同 |
| `--model x` | x | x（全阶段） |
| `KEEL_MODEL_PROFILE=enterprise` | 不生效 | 按阶段表 |
| claude 未指定模型 | 不传 `--model` | 同（`spec.model` 不传给 claude） |

## 5. 测试

- `resolveStageModel`：四层优先级、非法 profile、allowlist 命中/未命中。
- `buildArgv`：`spec.model` 覆盖 fallback；未设时用 fallback。
- 编排器（注入 stub adapter）：断言 `run.requested_model` 等于 stub 收到的 `spec.model`，
  且 enterprise profile 下 develop 与 pm 使用不同模型。
- 迁移：`pnpm run db:migrate` 后列存在（现有测试库流程覆盖）。

## 6. 回滚

- 迁移只加列，回滚可 `DROP COLUMN`，不影响既有数据。
- 代码回滚 = revert commit；profile 缺省 `default` 保证行为不变。
