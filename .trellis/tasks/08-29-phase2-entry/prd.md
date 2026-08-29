# 阶段二入口验证

## Goal

满足 `docs/09-roadmap.md` §4.1 **阶段二触发条件**，使项目从「v0.1 判据单次证明」进入「阶段二正式内容」（第二个 AI Harness、Critic、Context 优化、dogfooding）。

父任务**不直接写产品代码**，负责：子任务编排、跨子任务验收、触发条件核对、证据归档。

## Background（已核验）

| 事实 | 来源 |
|---|---|
| v0.1 判据已闭合（真实 Issue → S-DONE + 真实 CI PR，T-001→T-024） | `08-27-github-issue-automation` 归档 prd，PR #36 |
| 阶段二触发 #1（v0.1 判据）| ✅ |
| 阶段二触发 #2（连续 5 个真实 Task 无人工干预）| ✅ 2026-08-29 第二次五连 5/5（见 `08-29-five-run-campaign`） |
| 阶段二触发 #3（事件流四问）| ✅ 抽样 task `68eb4965-9aca-4940-a586-d5f8a8f83beb`：`readEvents` + ContextBuilt `source_ref`/`dropped` |
| 阶段二触发 #4（ADR-0003 ✅；0005 后果「第二 Harness」）| ⚠️ 仅 OMP 为 AI harness |
| ADR-0005 明确：第二个 AI harness 是阶段二**首要验证目标** | `docs/adr/0005-harness-support-tiers.md` |

## Key Decisions

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 子任务顺序 | **五连 →（墙钟 ADR 按需）→ 第二 Harness → Poller** | 五连是阶段二入口硬门槛；Harness 需稳定基线；Poller 按频次触发 |
| D2 | 五连 Issue 类型 | 与 `issue-e2e` 同型（文档-only、low/low） | 已验证可过 Policy；测稳定性而非功能 |
| D3 | 第二 Harness 选型 | **Claude Code**（MVP Adapter） | ADR-0005 原首选；L2 已调研；与 OMP 能力正交 |
| D4 | Poller 形态 | CLI daemon 轮询，非 Webhook | `08-27-github-issue-automation` Phase 3 立项；Webhook 需 HTTP 服务 |
| D5 | 父任务实现范围 | **零产品代码** | 子任务各自可独立 verify/archive |

## Child Task Map

| 子任务 | 职责 | 阻塞关系 |
|---|---|---|
| `08-29-five-run-campaign` | 5 连 `run-issue --ci real`，JSONL 证据 | **已归档 5/5** |
| `08-29-omp-model` | OMP `--model` / `KEEL_MODEL` 透传 | **当前优先**；不换 Harness |
| `08-29-wallclock-adr` | R-009 墙钟语义 ADR + 可选实现 | 五连超时未阻塞终态，非紧急 |
| `08-29-second-harness` | Claude Code Adapter MVP | **推迟**（D0：换模型 ≠ 换 Harness） |
| `08-29-ingress-poller` | daemon 轮询 ingest+run-issue | 依赖「人工跑 CLI 成瓶颈」信号 |

## Acceptance Criteria（父任务）

- [x] AC1：`08-29-five-run-campaign` 归档，prd 中 **5/5** S-DONE + `ci_verified` 记录
- [x] AC2：五连抽样证明 `docs/08-cross-cutting.md` §2.2 四问均可回答（task `68eb4965-9aca-4940-a586-d5f8a8f83beb`）
- [ ] AC3：`08-29-second-harness` 归档，至少 1 次真实验收（OMP 以外 AI harness 跑通 S-DONE 或诚实 AC6）
- [ ] AC4：父任务 prd 中阶段二触发清单 **全部勾选**
- [ ] AC5：`08-29-ingress-poller` 可仍为 planning（未触发时不阻塞父任务归档）

## Out of Scope

- 多 repo / 多租户、UI、自动 merge PR（roadmap §2.1）
- Temporal 迁移、Agent Pool 优化（阶段三）
- 放宽 Policy 提高五连成功率
- Webhook HTTP 服务（ingress-poller 子任务明确推迟）

## References

- `docs/09-roadmap.md` §4.1–4.4
- `.trellis/tasks/archive/2026-08/08-27-github-issue-automation/prd.md`
