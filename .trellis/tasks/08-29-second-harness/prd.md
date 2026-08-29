# 第二个 AI Harness（Claude Code）

父任务：`.trellis/tasks/08-29-phase2-entry`。

本任务 **planning 冻结**：待 `08-29-omp-model` 完成后再评估是否仍要 Claude Adapter。

## Goal

实现 **ClaudeCodeAdapter** MVP，验证 ADR-0005：「Harness 可替换」且切换**不改** Control / Fact 契约（转移表、事件 schema、Policy）。

## Background（已核验）

| 事实 | 出处 |
|---|---|
| v0.1 生产路径只接线 `new OmpAdapter()` | `src/cli/run-task.ts`（约 L125）；acceptance 同样硬编码 |
| `runTaskToCompletion` 已通过 `deps.adapter` 注入 | `src/control/orchestrator/loop.ts` —— **换 Adapter 不必改 loop** |
| Human 是 L0，OMP 是 L2；无第二个 AI Adapter | `src/execution/adapters/` |
| OMP Adapter **写死默认模型** `deepseek-v4-flash` | `src/execution/adapters/omp.ts` `opts.model ?? 'deepseek-v4-flash'`；CLI **无** `--model` |
| Claude Code 文档级 L2 | `harness-adapter.md` §1.3；**本机 argv 未实测** |
| 五连依赖已满足 | `08-29-five-run-campaign` 第二次 5/5 |

### 为什么 roadmap 把「第二 Harness」排第一（以及为什么可以反对）

ADR-0005 / `docs/09-roadmap.md` §4.2 #1 要证的是 **「执行层 CLI 可替换」**（session/resume/权限/事件流/untrusted workspace），不是「换一个更聪明的模型」。

**换模型 ≠ 换 Harness：**

| | 在 OMP 里换 `--model` | 再接 Claude Code Adapter |
|---|---|---|
| 测的是 | 同一套工具/会话/降级路径下，**推理质量** | 另一套 CLI 的 capability 与 Adapter 契约 |
| 用户能感到的 | 成功率、超时、Policy 波动 | 几乎感觉不到（闭环长得一样） |
| v0.1 现状 | **未暴露**：模型写死 deepseek | 架构保险，成本高 |

若产品核心是「更好的模型把 Task 做完」，第二 Harness **不是**最高杠杆；把 `KEEL_MODEL` / `--model` 接到已有 `OmpAdapter({ model })` 才是。第二 Harness 的正当理由只剩：不想绑死 Oh My Pi 这一家 CLI。

## Key Decisions（规划中）

| # | 决策 | 倾向 | 状态 |
|---|---|---|---|
| D0 | 阶段二下一步 | **推迟 Claude Adapter，先做 OMP 模型可配**（任务 `08-29-omp-model`） | ✅ 用户 2026-08-29 |
| D1 | 若仍做第二 Harness | Claude Code 官方 CLI | 仅在 D0=继续 Harness 时有效 |
| D2 | 输出契约 | MVP **仍 `post_validate`** | 仅在 D0=继续 Harness 时有效 |
| D3 | 选择面 | `--harness` > `KEEL_HARNESS` > 缺省 omp | 仅在 D0=继续 Harness 时有效 |

## Requirements

- R1 本机（或本环境）实测 `research/claude-code-interface.md`：argv、事件流、resume、cost、`--bare`、退出码。查不到标 `未验证`，不编造。
- R2 `ClaudeCodeAdapter` 实现 `HarnessAdapter`：HEADLESS + UNTRUSTED_WORKSPACE + STREAM + RESUME + COST（以实测为准裁剪 capability 声明）。
- R3 `output_contract.mode = post_validate`（与 OMP 同路径）；不在本任务启用 native json-schema。
- R4 `run-task` / `run-issue` 经 `--harness` / `KEEL_HARNESS` 构造 Adapter；缺省保持 **omp**（不悄悄换默认）。
- R5 缺 `claude` 二进制时 **启动即失败**（preflight，对标 `preflightOmp`），不走到 T-031 假绿。
- R6 opt-in `claude-code-e2e.acceptance.test.ts`：低风险 Issue 模板，`--ci real`。

## Acceptance Criteria

- [ ] AC1：`pnpm run check` 全绿（含 adapter spawn 单测，对标 `adapters.test.ts`）
- [ ] AC2：**待 D4** —— 要么 1 次真实 S-DONE / 诚实 AC6；要么 Adapter+单测+preflight，e2e 环境缺失时明确失败并记入 prd（不归档为「已验证可替换」）
- [ ] AC3：切换 harness 不改 `docs/schemas/`、转移表、Policy 规则集
- [ ] AC4：`research/claude-code-interface.md` 每项能力有实测或明确 `未验证`

## Out of Scope

- Codex / OpenCode / TRAE
- 本任务启用 `CAP-STRUCTURED_OUTPUT` 原生路径
- 同 Task 双 harness 并行
- 改默认 harness 为 Claude（避免五连/CI 依赖 Anthropic）

## Dependency

五连 ≥3/5：**已满足**。
