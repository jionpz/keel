# 执行面模型路由

> 代码：`src/execution/model-routing.ts`；落库列：`run.requested_model`。
> 现行模型路由从 issue #156 的修复开始，managed 与 legacy 共用解析逻辑。

## managed 阶段的 Harness

设置 `KEEL_MANAGED_HARNESS_ROUTING_FILE` 指向部署端的 JSON 文件：

```json
{
  "default_harness": "pi",
  "stage_harnesses": {
    "plan": "claude",
    "review": "claude"
  }
}
```

- `stage_harnesses` 可指定 `plan`、`execute`、`verify`、`review`、`land`，
  Harness 取值为 `omp`、`claude`、`pi`。
- 优先级为显式 `--harness` → 对应阶段 → `default_harness` → `KEEL_HARNESS` → `omp`。
  `--harness` 会跳过阶段路由文件，所有阶段统一用该 Harness。
- `serve` 和 managed 的 `ticket-*`、`workflow-*` 执行入口使用此配置。ticket 天问及
  `serve` 内的只读调查由默认 Harness 处理。独立调查 worker 和 legacy ingress
  继续使用各自的 `--harness` / `KEEL_HARNESS`。
- 启动时校验配置并预检所选 Harness 的 CLI 和模型 profile。加载了模型 profile 时，每种
  所选 Harness 都需要自己的表。`--model` / `KEEL_MODEL` 仍全局覆盖所选 Harness 的模型。
- 每个阶段先选 Harness，再使用该 Harness 的工具清单解析固定包中的工具策略，按该
  Harness 的模型配置和超时执行。租约按实际路由中最长的阶段上限计算，并覆盖天问的固定上限。
  远程交付仍由动作网关负责。
- ticket 阶段可选的 Harness 取决于固定 jstack 包及实际工具能力。仓库随附的
  工具策略包含 Pi 与 Claude Code 的映射。ticket 阶段路由到 OMP 需要固定包提供 OMP 映射。

实现入口为 `src/cli/managed-harness-routing.ts` 和 `src/cli/managed.ts`。

---

## 项目不预设模型

运行时路径**不包含**任何模型 id、模型目录或 thinking 等级。不同部署可用的
provider / 模型目录不同，把某套目录写进源码会让换环境时必须改代码。

项目只保留机制：

- `KEEL_MODEL_PROFILES_FILE` 指向部署方提供的 profile JSON；
- `KEEL_MODEL_PROFILE` 选择其中一个 profile；
- `--model` / `KEEL_MODEL` 是显式覆盖；
- stage / role 的具体模型和可选 thinking 由 profile 决定；
- managed 工作流阶段的墙钟上限 `timeout_s` 也由 profile 决定，缺省 15 分钟；
- 没有配置模型时不传 `--model`，由 harness 自己的用户配置决定。

示例见 `docs/examples/model-profiles.example.json`，其中全部是占位符。

## 配置结构

```json
{
  "profiles": {
    "team-a": {
      "omp": {
        "stages": {
          "develop": { "model": "<model-id>" },
          "managed_investigate": { "model": "<model-id>" },
          "execute": { "model": "<model-id>", "timeout_s": 1800 },
          "verify": { "timeout_s": 2400 }
        },
        "roles": {
          "Reviewer": { "model": "<model-id>" }
        }
      },
      "pi": {
        "roles": {
          "Reviewer": { "model": "<model-id>", "thinking": "<level>" }
        }
      }
    }
  }
}
```

- 第一层 `profiles` 是 profile 名 → harness 表。
- profile 名与 `KEEL_MODEL_PROFILE` 使用同一规则：字母或数字开头，只含字母、
  数字、点、下划线和短横线；配置文件里选不中的键直接拒绝。
- harness 只接受 `omp` / `claude` / `pi`，与 adapter 的 `harness_id` 对齐。
- 每个 harness 表只接受 `stages` / `roles`，两者至少有一个。
- stage / role 条目只接受 `model` / `thinking`，且至少有一个非空字符串；managed 工作流
  阶段的 stage 条目另外接受 `timeout_s`，见下文“阶段墙钟上限”。
- 配置按 harness 分开：同一 profile 不把 omp 的模型串给 pi 或 claude。
- 选中 profile 后，当前 harness 必须有对应表；缺表直接失败，不静默当作未配置。

支持的路由阶段：

```
pm · brainstorm · critic · rfc_draft · develop · qa · review
managed_investigate · tianwen · plan · execute · verify · land
```

支持的路由角色：

```
PM · Critic · Developer · QA · Reviewer · Architect · Security
Investigator · Tianwen
```

`managed_investigate` / `tianwen` 是 managed 只读调查；`execute` / `verify` /
`review` / `land` 是 managed ticket 阶段；`plan` 是 workflow planner。
`review` 与 legacy review 共用同一阶段键，其余 managed 阶段独立配置。

## 优先级

```
--model / KEEL_MODEL  >  role  >  stage  >  不传
```

`thinking` 独立按 `role > stage` 解析：即使 model 来自显式 override，
role / stage 上的 thinking 仍然生效。两处都缺 = 不传，由 harness 决定。

`resolveModelRoute()` 是唯一裁决点。adapter、CLI、编排器、managed worker
都不许各算一遍——两份解析会在某次改动后悄悄漂移，表现是「库里记 A、实际跑 B」。

所有支持模型覆盖的入口都调用同一个函数：

- legacy 编排：`src/control/orchestrator/loop.ts`
- 单 ticket worker / 天问 / planner：
  `src/execution/isolated-ticket-worker.ts`
- managed 只读调查：`createIsolatedManagedInference`
- `run-task` / `run-issue` / `poller` / `serve` / `managed worker` 的启动期预检

## 阶段墙钟上限

managed 工作流阶段的墙钟上限和模型写在同一份 profile 里：阶段需要多久取决于给它
配了哪个 harness、哪个模型，两者一起调。

- `timeout_s` 只接受写在 `stages` 的 `plan` / `execute` / `verify` / `review` / `land`
  条目上，值是 60 到 14400 的整数秒。只写 `timeout_s`、不写模型的条目是合法的。
- 写在其他阶段键（legacy 阶段、`managed_investigate`、`tianwen`）或任何 role 条目上
  会在启动期拒绝。这些位置不会生效，接受它等于让配置看起来有效。
- 它不参与模型优先级：只按阶段取值，不受 role 与 `--model` / `KEEL_MODEL` 影响。
- 缺项时用缺省的 900 秒。天问固定 900 秒，只读调查固定 90 秒，两者不可配。
- `review.timeout_s` 只作用于 managed review。legacy review 的墙钟仍由 ADR-0009 的
  策略表与 `--wall-clock` 决定。
- 取值范围是为了拦住单位写错：下限挡住把分钟写进秒字段（`30`），上限挡住把毫秒
  写进秒字段（`1800000`）。

`configuredStageTimeoutS()` 是唯一读取点，`stageTimeoutsFor()` 把它换算成每个阶段的
毫秒数。同一个数决定三件事，不各算一次：

1. `RunSpec.limits.wall_clock_s`。OMP 把它作为 `--max-time` 传给 harness；Pi 与
   Claude 不接收这个上限，只靠下一条的计时器。
2. 本进程强制中断的计时器（`interrupt(..., 'timeout')`）。
3. ticket 与 workflow 的租约：`max(各阶段上限, 900 秒) + 5 秒清理等待 + 60 秒余量`。

租约随上限变长的代价见 [ticket-execution.md](./ticket-execution.md) §3。

## 落库与 spawn 同源

legacy run 在认领后、spawn 前解析一次，结果同时用于：

1. `RunSpec.model` / `RunSpec.thinking`
2. `UPDATE run SET requested_model = $1`

```ts
const route = resolveModelRoute({ harness, stage, role, override, routing })
if (!route.ok) return failRunAndAdvance(...)   // 不 spawn
```

未配置模型时 `requested_model` 保持 `NULL`，不回填项目默认模型。
`requested_model` 只记录**请求值**，不证明 harness 接受了该模型（不做探活）。
旧 run 保持 `NULL`。

## harness 消费方式

- `OmpAdapter`：`spec.model` 优先于 adapter 级 fallback；两者都没有时不传 `--model`。
- `ClaudeCodeAdapter`：`spec.model` 优先于构造参数模型；没有时不传 `--model`。
- `PiAdapter`：`spec.model` 与 `spec.thinking` 分别覆盖构造参数；没有时不传
  `--model` / `--thinking`。

thinking 只由支持它的 harness 消费。当前只有 Pi 接受 thinking 覆盖；
`omp` / `claude` 配置了 thinking 会在启动期被拒绝，不会静默丢弃。

## allowlist 是启动期契约

`KEEL_MODEL_ALLOWLIST` 非空时，解析出的模型必须命中，否则拒绝并**不静默回退**。

`preflightModelRouting()` 检查选中 profile 下当前 harness 的**全部**
stage / role 条目，而不只检查当前可能要跑的那一条：

- 单个 legacy run 会跨多个 stage；
- managed 可能进入调查、天问、ticket stage 或 planner；
- `run-issue` / `poller` 若等到认领后才失败，已经先 ingest 并写了数据。

没有 profile、也没有显式 override 时，allowlist 不会因为“项目缺省模型”误报；
没有模型可约束时它自然通过。显式 override 始终受 allowlist 约束。

## 配置错误必须启动即失败

以下情况都返回 `CAPABILITY_UNSUPPORTED`，且发生在任何 DB 写入或 ingest 之前：

- `KEEL_MODEL_PROFILE` 为空或含非法字符；
- profile 文件里的 profile 名无法被 `KEEL_MODEL_PROFILE` 选中；
- 选了 profile 却没有 `KEEL_MODEL_PROFILES_FILE`；
- 文件不可读、JSON 非法、profile 不存在；
- 未知 harness / stage / role / 字段；
- 空表、空条目、空白 model / thinking；
- `timeout_s` 写在不生效的位置、不是整数，或超出 60 到 14400；
- 当前 harness 在 profile 中缺表；
- 非 Pi harness 配了 thinking；
- 最终模型不在 `KEEL_MODEL_ALLOWLIST`；
- 空白 `--model` / `KEEL_MODEL`。

配置校验是严格的：拼错字段或 stage 不会被忽略。
只设置 `KEEL_MODEL_PROFILES_FILE` 而不设置 `KEEL_MODEL_PROFILE` 时不会启用
profile 路由；配置了文件却忘了选择 profile，等于没有配置。

## 测试点

- 未配置路由：`RunSpec` 不带 model / thinking，`requested_model` 为 `NULL`；
- stage 配置、跨 stage 不同模型、role 覆盖 stage、override 覆盖 role / stage；
- managed stage（`managed_investigate` / `tianwen` / ticket / planner）可配置；
- thinking 只在 Pi 生效，omp / claude 配 thinking 启动期拒绝；
- `timeout_s`：五个工作流阶段接受、其余位置拒绝、范围校验；配置值同时出现在
  `wall_clock_s`、OMP 的 `--max-time`、中断计时器与租约上，缺省仍是 900 秒 / 965 秒；
- profile 缺 harness、未知阶段 / 角色 / 字段、空值均拒绝；
- allowlist 覆盖 profile 全部条目；未命中时不 spawn，`requested_model` 保持 `NULL`；
- `run-task` / `run-issue` / `poller` / managed worker 的预检先于认领或 ingest；
- stub adapter 记录的 `spec.model` 与 `run.requested_model` 相等。
