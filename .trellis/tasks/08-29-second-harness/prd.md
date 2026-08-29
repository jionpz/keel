# 第二个 AI Harness（Claude Code）

父任务：`.trellis/tasks/08-29-phase2-entry`。

## Goal

实现 **ClaudeCodeAdapter** MVP，验证 ADR-0005：「Harness 可替换」且切换**不改** Control / Fact 契约（转移表、事件 schema、Policy）。

## Background（已核验）

| 事实 | 出处 |
|---|---|
| v0.1 生产路径只接线 `new OmpAdapter()` | `src/cli/run-task.ts`（约 L125）；acceptance 同样硬编码 |
| `runTaskToCompletion` 已通过 `deps.adapter` 注入 | `src/control/orchestrator/loop.ts` —— **换 Adapter 不必改 loop** |
| Human 是 L0，OMP 是 L2；无第二个 AI Adapter | `src/execution/adapters/` |
| Claude Code 文档级 L2：`-p`、`--resume`、`stream-json`、`total_cost_usd`、`--bare`、`--json-schema` | `docs/05-contracts/harness-adapter.md` §1.3；`research/harness-interfaces.md` §1 |
| **本机 argv/事件流尚未实测**（与 OMP 当年纪律相同：文档 ≠ Adapter） | `research/claude-code-interface.md` 仍为待填 |
| 五连依赖已满足 | `08-29-five-run-campaign` 第二次 5/5 S-DONE（已归档） |

## Key Decisions（规划中）

| # | 决策 | 倾向 | 状态 |
|---|---|---|---|
| D1 | 目标 Harness | Claude Code（官方 `claude` CLI），不是 Cursor Agent | 已定（roadmap / ADR-0005） |
| D2 | 输出契约 | MVP **仍 `post_validate`**，即使 Claude 有 `--json-schema` | 已定（先证明 drop-in；原生 schema 另开） |
| D3 | 选择面 | `KEEL_HARNESS=omp\|claude` + CLI `--harness`（显式优先于 env） | 待你确认见下 |
| D4 | 本任务是否必须真实 S-DONE | **见本轮问题** | 未定 |

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
