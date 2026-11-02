# 执行面模型对接企业网关

> 对应 GitHub issue [#70](https://github.com/jionpz/keel/issues/70) §4，父任务
> `11-03-enterprise-deployment`。优先级 P1。

## Goal

让 keel 的缺省模型与企业内推理网关（OpenAI 兼容）的可用目录对齐，
并让「按阶段选模型」集中定义、可配置、可审计；落库值与实际 spawn 的模型完全一致。

## Background

- `src/execution/adapters/omp.ts:26` 的 `DEFAULT_OMP_MODEL = 'deepseek-v4-flash'`
  是 github.com 时期的缺省；企业网关没有这个模型。
- 当前模型在 adapter 构造时固定，`RunSpec` 不携带模型信息；
  `run` 表也没有记录请求模型的字段。
- 企业网关可用目录示例：`moonshotai/Kimi-K3`、`zai-org/GLM-5.3`、
  `zai-org/GLM-5.2`、`Qwen/Qwen3.8-27B-FP8`。

## Requirements

- **R1 缺省不破坏既有基线**：不设置任何新配置时，omp 缺省仍是 `deepseek-v4-flash`。
- **R2 profile 切换**：`KEEL_MODEL_PROFILE=enterprise` 时，按阶段使用企业网关目录：
  - `develop` / `qa` / `review` → `moonshotai/Kimi-K3`
  - `pm` / `brainstorm` / `critic` / `rfc_draft` → `zai-org/GLM-5.3`
- **R3 全局覆盖仍最高优先级**：`--model` > `KEEL_MODEL` > profile 表 > 内置缺省。
- **R4 集中定义**：profile 与阶段表只在一处定义，不散落在 adapter / CLI。
- **R5 落库一致**：`run.requested_model` 写入的值必须与 spawn 的 `--model` 值完全相同。
- **R6 拼错拒绝**：未知 profile 名拒绝；若设置 `KEEL_MODEL_ALLOWLIST`（逗号分隔），
  最终模型不在清单内则拒绝，不静默回退。
- **R7 claude 不受影响**：未显式指定模型时仍不传 `--model`。

## Acceptance Criteria

- [ ] 未设新变量时，omp argv 的 `--model` 仍是 `deepseek-v4-flash`，现有测试全绿。
- [ ] `KEEL_MODEL_PROFILE=enterprise` 时，各阶段 spawn 的模型与 R2 表一致。
- [ ] `run.requested_model` 与同一次 run 的 spawn argv 一致（有测试钉住）。
- [ ] 非法 profile / allowlist 外模型返回明确错误，进程不启动。
- [ ] `pnpm run check` 全绿。

## Constraints

- 不把企业网关地址、密钥写进代码；仍由部署方通过 harness 配置注入。
- 不做模型可用性探测（探活属于部署验收，不属于运行时代码）。
- 迁移只加列，不改既有行；旧数据 `requested_model` 为 NULL 是合法状态。

## Out of Scope

- 模型自动发现 / 能力探测。
- 按成本或负载动态路由。
- claude harness 的 per-stage 路由（保持现状）。
