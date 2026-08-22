# AI Engineering Runtime Architecture

## 1. 文档定位

本文档定义一个面向 AI 软件研发的 Runtime 架构，目标是让“人工开发”和“AI 自动开发”使用同一套工程规范、状态模型、上下文体系和 Agent Harness。

核心思想：

> Session inside, State outside.

即：在需要连续推理的阶段保留 Agent Session；跨阶段则通过结构化 State、Checkpoint 和 RFC 交接，而不是把完整对话一直传递下去。

---

## 2. 目标

### 2.1 自动研发闭环

用户反馈 → 需求判断 → Brainstorm → RFC → 开发 → QA → Review → PR → CI → 完成。

### 2.2 人工研发与 AI 研发统一

复杂需求可以由人工接管，但人工和 AI 都遵循同一套：

- 项目规则
- 架构规范
- RFC
- State
- Git 工作流
- QA / Review 标准
- Harness 能力

因此不会出现“AI 一套规范、人工另一套规范”的分裂。

### 2.3 Agent 可替换

模型、Coding Agent、Harness 都应该是可插拔的。

例如：

- Kimi K3
- GLM
- DeepSeek
- Grok
- OMP / Oh My Pi
- TRAE Agent Harness
- OpenCode
- OpenHands

都可以作为执行层替换，而不影响上层 Workflow。

---

## 3. 总体架构

```text
                    ┌──────────────────────┐
                    │   User / Feedback    │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Event / Ingress    │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Workflow Engine    │
                    │ Temporal / 自研状态机 │
                    └──────────┬───────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
        ┌────────────────┐          ┌────────────────┐
        │ Session Manager│          │  Policy Engine │
        └───────┬────────┘          └───────┬────────┘
                │                           │
                ▼                           ▼
        ┌──────────────────────────────────────────┐
        │              Agent Runtime               │
        │                                          │
        │ PM / Brainstorm / Critic / Developer     │
        │ QA / Reviewer / Architecture / Security  │
        └───────────────────┬──────────────────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │    Context Builder   │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Shared State / RFC   │
                 │ Checkpoint / Memory  │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Coding Harness       │
                 │ OMP / TRAE / etc.    │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Git / CI / PR        │
                 └──────────────────────┘
```

---

## 4. 核心模块

### 4.1 Workflow Engine

负责“什么时候做什么”。

它不负责：

- 写代码
- 选择技术方案
- 业务判断
- Agent 内部推理

它只负责：

- 状态推进
- 调用哪个 Agent
- 等待结果
- 重试
- 超时
- 人工介入
- 恢复任务

推荐：

- Temporal：长期、可靠、可恢复
- Inngest：事件驱动、轻量
- 前期也可以自研一个简单 State Machine

---

## 5. Session Manager

Session Manager 是本系统非常关键的一层。

它负责 Agent 的生命周期：

```text
CREATE
  ↓
RUNNING
  ↓
CHECKPOINT
  ↓
RUNNING
  ↓
PAUSED
  ↓
RESUMED
  ↓
COMPLETED
  ↓
DESTROYED
```

重要原则：

> Agent Session 是临时计算资源，不应该成为系统事实的唯一来源。

真正的事实应该保存在 State / RFC / Checkpoint 中。

---

## 6. Session 与 State 的关系

推荐采用：

> Session inside, State outside.

例如 Brainstorm 阶段：

```text
PM Session
   │
   ├── Question 1
   ├── Question 2
   ├── Question 3
   ├── ...
   └── Question 10
          │
          ▼
      RFC / State
```

PM Session 可以连续运行 10 轮甚至 50 轮。

但是每隔 N 轮，Runtime 生成 checkpoint：

```json
{
  "task_id": "TASK-1024",
  "stage": "brainstorm",
  "progress": "6/10",
  "confirmed_facts": [],
  "open_questions": [],
  "candidate_options": [],
  "decisions": [],
  "risks": [],
  "next_action": "continue_brainstorm"
}
```

这样即使 Session 崩溃，也可以恢复。

---

## 7. Brainstorm 的关键设计

Brainstorm 不应该设计成：

```text
Agent A → Agent B → Agent C → Agent D
```

也不要让多个 Agent 自由聊天。

推荐：

```text
                Workflow Runtime
                       │
                       ▼
                  PM Session
                       │
                ┌──────┴──────┐
                │             │
                ▼             ▼
             Tools         Critic
                │             │
                └──────┬──────┘
                       ▼
                 Shared State
```

PM 是连续 Session。

Critic 是一种受 Runtime 控制的能力调用。

---

## 8. PM 如何调用 Critic

PM 不需要知道 Critic 的具体实现。

例如 PM 当前产生：

```json
{
  "type": "request_review",
  "review_type": "architecture",
  "options": [
    {
      "id": "A",
      "summary": "修改现有导出接口"
    },
    {
      "id": "B",
      "summary": "建立新的 Export Service"
    },
    {
      "id": "C",
      "summary": "直接在 SQL 层增加过滤"
    }
  ]
}
```

Runtime 根据 Policy 判断：

```text
brainstorm + multiple_options
        ↓
必须调用 Critic
        ↓
启动 Critic Session
        ↓
返回结构化 Review
        ↓
写入 State
        ↓
继续 PM Session
```

Critic 输出：

```json
{
  "review_type": "architecture",
  "scores": {
    "A": 8.2,
    "B": 7.4,
    "C": 5.1
  },
  "risks": [
    "B 改动范围较大",
    "C 未来扩展性较差"
  ],
  "recommendation": "A"
}
```

Runtime 把结果写入 State，然后恢复 PM Session。

PM 不需要重新从零理解任务。

---

## 9. 为什么不是每个问题都重新创建 Agent

错误方式：

```text
Question 1 → Agent #1
Question 2 → Agent #2
Question 3 → Agent #3
...
Question 10 → Agent #10
```

这会造成：

- 重复读取上下文
- Token 浪费
- 连续推理丢失
- Brainstorm 质量下降

推荐：

```text
创建 PM Session
       ↓
Question 1
       ↓
Question 2
       ↓
调用 Critic
       ↓
Question 3
       ↓
Question 4
       ↓
Checkpoint
       ↓
继续
       ↓
...
       ↓
RFC 完成
       ↓
销毁 PM Session
```

只有跨角色时才发生 Session 切换。

---

## 10. Context Builder

Context Builder 负责决定：

> 这个 Agent 这一轮到底应该看到什么。

不要把整个数据库、整个代码库、所有历史对话都塞进去。

### PM Context

```text
用户反馈
+
历史类似问题
+
产品规则
+
架构规范
+
当前 State
+
最近 Brainstorm Context
```

### Developer Context

```text
RFC
+
架构规范
+
相关代码
+
Git 状态
+
开发规则
+
测试要求
```

### Reviewer Context

```text
RFC
+
Git Diff
+
测试结果
+
架构规则
+
风险策略
```

这样可以显著降低 Token。

---

## 11. Checkpoint

Checkpoint 不应该保存完整对话作为主要恢复机制。

推荐保存：

```json
{
  "task_id": "TASK-1024",
  "stage": "brainstorm",
  "facts": [],
  "decisions": [],
  "options": [],
  "critic_feedback": [],
  "unresolved_questions": [],
  "current_goal": "",
  "next_action": "",
  "context_summary": ""
}
```

完整对话可以作为 Debug / Audit 数据保存，但不是每次恢复都加载。

---

## 12. Policy Engine

Policy 决定：

> 什么情况下允许 Agent 自动推进。

例如：

```yaml
rules:
  - condition: "risk == high"
    action: "human_review"

  - condition: "files_changed > 30"
    action: "architecture_review"

  - condition: "security_related == true"
    action: "security_review"

  - condition: "complexity == low && risk == low"
    action: "auto_develop"

  - condition: "tests_failed >= 3"
    action: "human_review"
```

这比把所有规则写进 Prompt 更可靠。

---

## 13. 需求自动开发案例

用户反馈：

> “导出的 Excel 希望能够按照日期筛选。”

流程：

```text
FeedbackCreated
      ↓
PM_ANALYZING
      ↓
PM Session
      ↓
Brainstorm
      ↓
Critic
      ↓
PM 决策
      ↓
RFC_READY
      ↓
Policy Check
      ↓
AUTO_DEVELOP
      ↓
Developer Session
      ↓
TRAE / OMP Harness
      ↓
Tests
      ↓
QA
      ↓
Reviewer
      ↓
Create Branch
      ↓
Create PR
      ↓
CI
      ↓
DONE
```

---

## 14. 复杂需求案例

用户反馈：

> “整个权限系统重新设计一下。”

PM 判断：

```text
complexity = high
risk = high
```

Policy：

```text
AUTO_DEVELOP = false
```

流程：

```text
Feedback
   ↓
PM
   ↓
Brainstorm
   ↓
Architecture Review
   ↓
RFC
   ↓
HUMAN_REVIEW
   ↓
人工开发
   ↓
仍然使用 TRAE Harness
   ↓
QA / Review
```

这样人工开发和 AI 开发仍然遵循同一套 RFC、Policy、Harness 和工程规范。

---

## 15. 推荐的 State Machine

```text
NEW
 │
 ▼
PM_ANALYZING
 │
 ├── NEED_CLARIFICATION
 │
 ├── REJECTED
 │
 └── BRAINSTORM
          │
          ▼
       RFC_DRAFT
          │
          ▼
       RFC_READY
          │
          ├── HUMAN_REVIEW
          │
          └── AUTO_DEVELOP
                    │
                    ▼
                 DEVELOPING
                    │
                    ▼
                    QA
                    │
              ┌─────┴─────┐
              │           │
            FAIL         PASS
              │           │
              ▼           ▼
           REWORK       REVIEW
                          │
                    ┌─────┴─────┐
                    │           │
                  FAIL         PASS
                    │           │
                    ▼           ▼
                  REWORK      CREATE_PR
                                  │
                                  ▼
                                  CI
                                  │
                                  ▼
                                 DONE
```

---

## 16. Agent 生命周期

### PM

长 Session。

生命周期：

```text
CREATE
→ Brainstorm
→ Critic Calls
→ Checkpoint
→ RFC
→ COMPLETE
→ DESTROY
```

### Critic

短 Session / 短任务。

```text
CREATE
→ Read Context
→ Review
→ Return Structured Result
→ DESTROY
```

### Developer

一个完整开发任务保持一个主要 Session。

```text
CREATE
→ Read RFC
→ Explore
→ Implement
→ Test
→ Checkpoint
→ COMPLETE
```

### QA / Reviewer

以任务为单位运行，必要时重新启动。

---

## 17. Git 集成

Agent 不应该直接操作生产主分支。

推荐：

```text
main
 │
 └── ai/task-1024
          │
          ├── commits
          ├── tests
          └── review
                │
                ▼
              PR
```

Workflow Engine 维护：

```json
{
  "branch": "ai/task-1024",
  "commit_sha": "...",
  "pr_number": 123,
  "ci_status": "running"
}
```

---

## 18. 人工接管

任何阶段都可以：

```text
PAUSE
  ↓
HUMAN_TAKEOVER
  ↓
Human Session
  ↓
继续使用同一个 State / RFC
  ↓
RESUME
```

这也是整个系统非常重要的能力。

AI 并不是“成功或失败”二元模式，而是：

```text
AI → Human → AI
```

可以自由切换。

---

## 19. 模型层

模型应该完全与 Workflow 解耦。

建议抽象：

```text
ModelProvider
    │
    ├── Kimi
    ├── GLM
    ├── DeepSeek
    └── Grok
```

再抽象：

```text
Agent Runtime
    │
    ├── TRAE Harness
    ├── OMP
    ├── OpenCode
    └── OpenHands
```

最终形成：

```text
Workflow
    ↓
Agent Role
    ↓
Runtime Adapter
    ↓
Harness
    ↓
Model
```

因此模型升级不会影响整个系统。

---

## 20. 推荐技术栈

### 第一阶段

不要一开始做得过重。

```text
API / Event
      ↓
简单 Workflow State Machine
      ↓
Session Manager
      ↓
PostgreSQL
      ↓
TRAE Harness / OMP
      ↓
GitHub
```

先把核心闭环跑起来。

### 第二阶段

增加：

- Checkpoint
- Context Builder
- Policy Engine
- Critic
- QA Agent
- Reviewer Agent

### 第三阶段

再考虑：

- Temporal
- 多项目调度
- Agent Pool
- 并发任务
- Observability
- Cost Tracking
- Evaluation
- 自动回滚
- 多 Agent Team

---

## 21. 最核心的设计原则

### 原则一：State 是事实

Agent 的对话不是事实来源。

### 原则二：Session 是计算资源

Session 可以创建、暂停、恢复、销毁。

### 原则三：Workflow 决定流程

Agent 不应该自己决定整个系统怎么运行。

### 原则四：Policy 决定权限

什么可以自动做、什么必须人工审核，由 Policy 控制。

### 原则五：Context Builder 决定上下文

不要让 Agent 每次都从零读取整个项目。

### 原则六：Harness 是执行层

TRAE / OMP / OpenCode 等都应该可以替换。

### 原则七：人工与 AI 使用同一套工程规范

这是整个系统长期价值非常重要的一点。

---

## 22. 最终形态

最终希望形成：

```text
                  AI Engineering Runtime
                           │
          ┌────────────────┼────────────────┐
          │                │                │
       Workflow          Policy           State
          │                │                │
          └────────────────┼────────────────┘
                           │
                    Session Manager
                           │
                  ┌────────┴────────┐
                  │                 │
              Human Session     Agent Session
                  │                 │
                  └────────┬────────┘
                           │
                     Context Builder
                           │
                    Agent / Harness
                           │
                ┌──────────┼──────────┐
                │          │          │
               PM       Developer    QA
                │          │          │
                └──────────┼──────────┘
                           │
                         Git
                           │
                           ▼
                          PR
```

这个 Runtime 最终不是“另一个 Claude Code”。

它真正解决的是：

> 如何让 AI、人工、多个 Agent、多个模型、多个 Harness 在同一个软件研发流程中长期协作。

这才是整个项目最值得做的部分。
