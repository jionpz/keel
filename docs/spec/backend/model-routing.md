# 执行面模型路由

> 记录**实际**做法。来源：`11-03-execution-model-routing`（issue #70 §4）。
> 代码：`src/execution/model-routing.ts`；落库列：`run.requested_model`。

---

## 优先级链只有一处

```
--model  >  KEEL_MODEL  >  KEEL_MODEL_PROFILE 阶段表  >  DEFAULT_OMP_MODEL
（显式 override，CLI 层已合并）      （enterprise / default）      （deepseek-v4-flash）
```

`resolveStageModel()` 是唯一裁决点。adapter、CLI、编排器都不许各算一遍——
两份解析会在某次改动后悄悄漂移，表现是「库里记 A、实际跑 B」。

- `DEFAULT_OMP_MODEL` 与 `ENTERPRISE_STAGE_MODELS` 只在 `model-routing.ts` 定义；
  `adapters/omp.ts` 只 re-export。
- `RunSpec.model` 是 omp 的覆盖入口：`buildArgv` 取 `spec.model ?? fallbackModel`。
- **claude 不消费 `spec.model`**：未显式指定就不传 `--model`；显式值仍走构造参数。

## 落库必须与 spawn 同源

认领 run 后、spawn 前解析一次，结果同时用于：

1. `runSpec.model`（最终进 argv 的 `--model`）
2. `UPDATE run SET requested_model = $1`

```ts
const model = resolveStageModel({ stage, override, profile, allowlist })
if (!model.ok) return failRunAndAdvance(...)   // 不 spawn
```

不允许「编排器算一次、adapter 再算一次」。测试用 stub 记录 `spec.model`，
再回读 `run.requested_model` 断言相等；`buildArgv` 另有单测钉住采用关系。

`requested_model` 只记录**请求值**，不证明 harness 接受了该模型（不做探活）。
旧 run 保持 `NULL`，不用缺省模型回填历史。

## allowlist 是启动期契约，不是逐 run 检查

`KEEL_MODEL_ALLOWLIST` 非空时，最终模型必须命中，否则拒绝并**不静默回退**。

关键点：**启动期预检必须覆盖本次驱动可能 spawn 的全部 stage 模型**。
单个 run 会跨多个 stage（pm → … → review），若把校验留到认领后逐 stage 解析，
`run-issue` / `poller` 已经先 ingest 并写了 feedback / task，留下一条驱动不了的记录。

`preflightModelRouting()`：

- `omp`：用**同一个** `resolveStageModel` 把所有 `STAGES` 推演一遍
- 非 omp：只有显式模型会进 argv，仅校验显式值
- 空清单 = 不校验

代价（刻意接受）：enterprise + 只允许 Kimi 的清单会在启动时被拒，
即使这次任务理论上可能不经过 pm。宁可拒绝启动，也不要在 ingest 之后才失败。

## 配置错误必须启动即失败

- `KEEL_MODEL_PROFILE` 非法（含空值）→ `CAPABILITY_UNSUPPORTED`，点名变量与可选值
- `KEEL_MODEL_ALLOWLIST` 有空项（`a,,b`）→ 拒绝，空项不静默忽略
- 空白 `--model` / `KEEL_MODEL` → 拒绝，不静默回退
- 以上都发生在任何 DB 写入之前；`run-issue` / `poller` 的预检先于 ingest

## 新增 harness 时

模型路由按 `describe().harness_id === 'omp'` 分支。新增支持模型覆盖的 harness
必须**显式加分支**，不要让它落到 omp 的阶段表——那会把企业网关目录误用到别家。

## 测试点

- 四层优先级表驱动；非法 profile；allowlist 命中/未命中；空白值
- `buildArgv` 采用 `spec.model`，未设时用 fallback
- 编排器：stub 收到的 `spec.model` == 库里的 `requested_model`
- enterprise 下 `develop ≠ pm`
- 不设新变量时 omp 仍是 `deepseek-v4-flash`，claude 仍不传 `--model`
- preflight：非法清单在 ingest 前失败（零写入），且有反例测试证明预检真的拦住了
