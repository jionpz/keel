# Implement — 完善 Keel 架构框架

> 执行计划。顺序**不可随意调整** —— 它就是 `design.md` §4 的文档依赖顺序。
> 术语先冻结，流程最后写（流程是对骨架的证伪测试）。

---

## 前置状态

- [x] `prd.md` 完成（缺口清单 G1–G17、需求 R1–R11、验收标准）
- [x] `design.md` 完成（三平面骨架、两级状态机、Harness 分级、文档集结构）
- [ ] `research/` 落盘 —— **见 Stage 0，当前被网关故障阻塞**

---

## Stage 0 · 研究落盘 `[阻塞项]`

**背景**：三次子 agent 派发均因 `503 Service Unavailable`（anyrouter.top 网关）失败，
WebSearch 亦返回 `429`。研究是 ADR-0003 / 0005 / 0006 的**唯一事实输入**，不能跳过。

- [ ] 0.1 退避重试 WebSearch / 子 agent 派发
- [ ] 0.2 `research/harness-interfaces.md` —— 各 Harness 的 headless 入口、resume 句柄、结构化输出、成本上报、权限控制、workspace 交付方式
- [ ] 0.3 `research/workflow-engine.md` —— Temporal / Inngest / 自研 Postgres 状态机 / LangGraph checkpointer 的 state 与 checkpoint 模型
- [ ] 0.4 若持续不可用：**降级而非编造** —— 按 PRD Constraint 2，把无法查证项标 `未验证`，
      并在 `09-roadmap.md` 中把依赖该事实的决策标为 `Blocked on verification`，ADR Status 保持 `Proposed`

**验收**：
```bash
ls .trellis/tasks/08-22-keel-architecture-framework/research/
grep -c '未验证' .trellis/tasks/08-22-keel-architecture-framework/research/*.md   # 允许 >0，但必须显式存在
```

**门禁**：Stage 5（Harness 契约）与 Stage 8（ADR）**不得在 Stage 0 完成前定稿**。
Stage 1–4 与研究无依赖，可先行。

---

## Stage 1 · 术语冻结 → `docs/02-glossary.md`

满足 R1，关闭 G1。

- [ ] 1.1 建立 `docs/` 骨架目录
- [ ] 1.2 逐词定义 ≥14 个核心名词：`Task` `Feedback` `RFC` `State` `Checkpoint` `Session` `Run` `Event` `Policy` `Context` `Artifact` `Harness` `Adapter` `Role`
- [ ] 1.3 每词写全三要素：**一句定义 / 与易混词的区分 / 生命周期归属（谁创建·谁写·何时销毁）**
- [ ] 1.4 附一节「初稿中的术语混用点」，逐条列出 G1 的具体犯案位置并给出正名

**验收**：每个词条三要素齐全；`State` 与 `Checkpoint`、`Context` 与 `Memory`、`Task` 与 `Run` 各有显式区分段落。

---

## Stage 2 · 领域模型 → `docs/03-domain-model.md`

满足 R2，关闭 G11。

- [ ] 2.1 实体清单 + 字段 + 类型 + 主外键 + 不变量
- [ ] 2.2 实体关系图
- [ ] 2.3 **写权限矩阵**：每个实体 × 三平面 → 可读/可写/禁止（`design.md` §2.2 的直接落地）
- [ ] 2.4 `A-RFC` 实体定义（G11 的正式关闭点）
- [ ] 2.5 Event log 表设计（`design.md` §2.6）

**验收**：
```bash
# 逻辑 schema 必须细到能直接写出 DDL：每个实体都要有主键与类型
grep -c 'PRIMARY KEY\|主键' docs/03-domain-model.md
```
写权限矩阵中**不得存在执行平面对事实平面的"可写"格**——违反中心不变量。

---

## Stage 3 · 状态机 → `docs/04-state-machine.md`

满足 R3，关闭 G8。

- [ ] 3.1 Task 级状态清单（含终态），ID 用 `S-*`
- [ ] 3.2 Run 级状态清单（含终态）
- [ ] 3.3 Task 级转移表：`T-NNN | from | event | guard | to | side-effect`
- [ ] 3.4 Run 级转移表，覆盖 `FAILED` / `TIMEOUT` / `CANCELLED`
- [ ] 3.5 人工介入路径：`PAUSE → HUMAN_TAKEOVER → RESUME`（初稿 §18）
- [ ] 3.6 回滚路径（初稿完全没有）
- [ ] 3.7 幂等与重放语义：幂等键 `(task_id, stage, attempt)`，哪些 side-effect 必须幂等

**验收**（PRD 明确要求"无不可达状态、无非终态死端"）：
```bash
# 每个声明的状态都必须在转移表中作为 to 出现过（可达），或被标注为初态
# 每个非终态都必须至少有一条出边
# 手工核对 + 在文档内附一张「可达性/出边」自检表
```

---

## Stage 4 · 产物 schema → `docs/06-artifacts.md` + `docs/schemas/*.schema.json`

满足 R5，关闭 G4、G6。

- [ ] 4.1 `A-State` / `A-Checkpoint` —— 必须写清两者的 owner 与生命周期差异（G6 关闭点）
- [ ] 4.2 `A-RFC`
- [ ] 4.3 `A-Event`
- [ ] 4.4 `A-CriticReview`
- [ ] 4.5 `A-PolicyDecision`
- [ ] 4.6 `A-CapabilityRequest` —— PM 请求能力调用的通用机制（G4 关闭点，`design.md` §2.3）
- [ ] 4.7 每个 schema 落成真实 `.json` 文件，含 `version` 字段
- [ ] 4.8 每个 schema 配一个**真实**示例（用初稿 §13 的 Excel 案例，不要 `foo`/`bar`）

**验收**：
```bash
# 所有 schema 必须是合法 JSON，且都带 version 字段
for f in docs/schemas/*.schema.json; do
  python3 -c "import json,sys; d=json.load(open('$f')); assert 'version' in str(d), '$f 缺 version'" || echo "FAIL $f"
done
```

---

## Stage 5 · 核心契约 → `docs/05-contracts/*.md` `[依赖 Stage 0]`

满足 R4，关闭 G3、G5、G7、G10。

- [ ] 5.1 `harness-adapter.md` —— **本 Stage 的重头**
      - capability flags（`CAP-*`）与 L0/L1/L2 分级
      - **降级规则**：L0 harness 如何在无 resume 的情况下保持正确性
      - 各 Harness 实际落级 ← 来自 `research/harness-interfaces.md`
- [ ] 5.2 `session-manager.md`（关闭 G3：Session 写权限边界 + emit 协议）
- [ ] 5.3 `context-builder.md`（关闭 G5：token 预算与裁剪策略、配料来源）
- [ ] 5.4 `policy-engine.md`（关闭 G7：求值语义、facts 来源、冲突裁决、**默认 deny**）
- [ ] 5.5 `artifact-store.md`
- [ ] 5.6 `README.md` —— 契约总览 + 版本与兼容策略
- [ ] 5.7 澄清 `ModelProvider` 与 Harness 的职责边界（关闭 G10）

**约束**：签名一律**语言中立伪代码**（ADR-0002 未拍板前不得用任何具体语言语法）。
每个方法必须标注 `v0.1 必须` 或 `可延后`。

**验收**：
```bash
grep -c 'v0.1 必须\|可延后' docs/05-contracts/*.md   # 每个方法都要有标注
```

---

## Stage 6 · 端到端流程 → `docs/07-flows.md` `[REVIEW GATE]`

满足 R6。**这是对三平面骨架的证伪测试** —— 见 `design.md` §7 风险表最后一行。

- [ ] 6.1 流程一：自动开发闭环（初稿 §13 Excel 案例）
- [ ] 6.2 流程二：复杂需求 → 人工接管 → 交还 AI（初稿 §14 + §18）
- [ ] 6.3 流程三：失败重试 / 回滚（初稿缺失）
- [ ] 6.4 每步标注：读写了哪些 `A-*`、经过哪些 Policy 判定、对应哪条 `T-*`

**🚩 REVIEW GATE**：若任一流程**跨不过** Context Builder / Emit Protocol 这两座桥，
说明骨架有问题 —— **回改 `design.md` §2 与上游文档，不得给流程开后门**。
这是本任务唯一允许回退到前序 Stage 的检查点。

**验收**：三条流程的每一步都能映射到已存在的 `T-*` 与 `C-*` ID；出现悬空引用即不通过。

---

## Stage 7 · 跨切面 → `docs/08-cross-cutting.md`

满足 R7，关闭 G9、G12、G13、G14。

- [ ] 7.1 安全：凭据模型、代码执行隔离、git 写权限范围、**prompt injection**（Agent 消费用户反馈这类不可信输入）
- [ ] 7.2 可观测：trace/span 模型、结构化日志字段、"这个 Task 到底发生了什么"如何回答
- [ ] 7.3 成本：token/cost 归属到 Task、超预算行为
- [ ] 7.4 并发：同仓库多任务、锁与隔离策略（关闭 G9 的 worktree 部分）

**约束**：每项**必须**给出 v0.1 最低要求。

**验收**：
```bash
# 不允许把跨切面推给未来
grep -n '以后再说\|后续考虑\|待定' docs/08-cross-cutting.md   # 期望无输出
```

---

## Stage 8 · 路线与 ADR `[依赖 Stage 0]`

满足 R8、R9，关闭 G2、G15、G16。

- [ ] 8.1 `docs/09-roadmap.md`：Non-Goals（G16）、**v0.1 完成判据（一句可验证的话，G15）**、阶段二/三**触发条件**
- [ ] 8.2 `adr/0001` 采用 ADR
- [ ] 8.3 `adr/0002` 实现语言与运行时
- [ ] 8.4 `adr/0003` Workflow engine 选型（G2 关闭点）—— 必须正面回答"先自研后换 Temporal"是路径还是陷阱
- [ ] 8.5 `adr/0004` 持久化与 Artifact 存储
- [ ] 8.6 `adr/0005` Harness 支持优先级与 capability 分级
- [ ] 8.7 `adr/0006` Session 恢复策略 —— 含 checkpoint 摘要恢复的**质量损失诚实评估**
- [ ] 8.8 `adr/README.md` 索引

**验收**：
```bash
grep -L 'Status:' docs/adr/0*.md      # 期望无输出：每份 ADR 都有 Status
grep -l 'Status: Proposed' docs/adr/0*.md   # 每个 Proposed 都必须出现在 prd.md 开放问题表中
```

---

## Stage 9 · 收口

满足 R10、R11。关闭 G17。

- [ ] 9.1 `docs/01-overview.md` —— **最后写**（定位/目标/Non-Goals 摘要/三平面模型/工具边界表）
- [ ] 9.2 工具边界表：Keel vs Trellis vs Claude Code 及各 Harness vs GitHub Actions（G17 关闭点）
- [ ] 9.3 `docs/README.md` —— 索引 + 建议阅读顺序 + 文档约定（`design.md` §5）
- [ ] 9.4 初稿移入 `docs/archive/`，头部加 `superseded by` 标注
- [ ] 9.5 更新根 `README.md` 指向新文档集

---

## Stage 10 · 全量验收

逐条核对 `prd.md` 的 Acceptance Criteria。

```bash
# A. 术语一致性：全文不得出现被术语表判为「弃用」的写法
# B. 缺口闭环：G1–G17 每条都应在某文档中被显式声明关闭，或列入开放问题
grep -rno 'G1[0-7]\|G[1-9]' docs/ | sort -u

# C. 引用完整性：文中出现的每个 S-* / T-* / C-* / A-* / CAP-* 都必须有定义处
grep -rhno 'S-[A-Z_]*\|T-[0-9]\{3\}\|C-[A-Za-z]*\.[a-zA-Z]*\|A-[A-Z][a-zA-Z]*\|CAP-[A-Z_]*' docs/ | sort -u

# D. Schema 合法性
for f in docs/schemas/*.schema.json; do python3 -m json.tool "$f" >/dev/null || echo "INVALID $f"; done

# E. 未验证断言必须显式标注（Constraint 2 的可验证形式）
grep -rn '未验证' docs/ research/ | wc -l
```

- [ ] 10.1 A–E 全部通过
- [ ] 10.2 `prd.md` Acceptance Criteria 逐条勾选
- [ ] 10.3 派发 `trellis-check` 复核（若网关恢复）

---

## 回滚点

| 时机 | 回滚方式 |
|---|---|
| Stage 6 REVIEW GATE 未过 | 回退到 `design.md` §2 改骨架，重做 Stage 2–5。**这是设计预期内的，不是失败。** |
| 任意阶段整体放弃 | 本任务全程无代码、无破坏性变更；`git revert` 单个 commit 即可完全恢复，初稿因归档不丢 |

---

## 与 Trellis 流程的对应

- Stage 0–9 = Phase 2.1 Implement（可分批派发 `trellis-implement`）
- Stage 10 = Phase 2.2 Quality check（`trellis-check`）
- 之后进 Phase 3：更新 `.trellis/spec/` → commit → 写回 gbrain `project/keel/state`
