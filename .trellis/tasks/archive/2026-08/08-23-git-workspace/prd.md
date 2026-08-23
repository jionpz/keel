# 工作区隔离与 git 集成

> 父任务：`08-23-v01-closed-loop`（子任务 7）

## Goal

把 `CreateBranch` / `CleanWorkspace` 这两个副作用从**记录意图**变成**真做**，
并落地 `docs/08-cross-cutting.md` 的两条 v0.1 强制要求：

| 要求 | 内容 |
|---|---|
| `N1` | **每个 Task 独立 git worktree** |
| `S1`–`S3` | 目标仓库内容不可信；工作区隔离 |

worktree 隔离同时解决**并发**与**安全**两件事，成本只是一条 `git worktree add`。

---

## Problem

当前编排器直接在一个共享目录里跑所有 session，且：

| 缺口 | 后果 |
|---|---|
| 无 worktree 隔离 | 多 Task 并发时互相污染工作树（违反 `N1`） |
| `CreateBranch` 只记意图 | 事件流说"建了分支"，实际没有 |
| develop 的改动不提交 | 改动只在工作树里，下一个阶段看不到确定的快照 |
| 无清理 | 终态后 worktree 永久堆积 |

---

## Scope

### In scope
- `GitWorkspace`：按 `repo.remote_url` 准备裸仓库 + 每 Task 一个 worktree
- 真实分支：名字由 `task_id` 决定（幂等所需，非随机）
- develop 后真实 commit
- 终态清理 worktree；`S-FAILED` **保留现场**
- 把 `CreateBranch` / `CleanWorkspace` / `PreserveWorkspace` 接上真实实现

### Out of scope（并说明理由）

| 项 | 理由 |
|---|---|
| GitHub PR 创建 | 需真实远程与凭据，**本机无法验证**。留在 `GitProvider` 接口后，诚实标注未实现 |
| CI 状态回读 | 同上；CI 仍是外部事实源 |
| 凭据注入 | 无远程可用时无从验证；接口预留 |

> 不做的部分**不写空实现**。`CreatePullRequest` 继续记 `SideEffectIntent` ——
> 事件流会如实说明"PR 这件事还没真的做"。

---

## Requirements

### R1 · worktree 隔离

```
<root>/repos/<repo_id>.git      裸仓库，共享对象存储
<root>/worktrees/<task_id>/     每 Task 独立工作树，独立分支
```

- 分支名 `ai/task-<short_id>`，**由 task_id 决定** —— 幂等的前提
- 重复调用复用已有 worktree，不报错

### R2 · 真实提交

develop 阶段结束后，把工作树里的改动 commit 到该 Task 的分支。
commit message 含 task_id，便于溯源。

### R3 · 清理策略

| 终态 | 处理 |
|---|---|
| `S-DONE` / `S-REJECTED` / `S-ABANDONED` | 移除 worktree（分支保留在裸仓库里） |
| **`S-FAILED`** | **保留现场** —— `04-state-machine.md` `T-041` 明确要求 |

### R4 · 接上副作用执行器

`CreateBranch` / `CleanWorkspace` / `PreserveWorkspace` 走真实实现，
不再记 `SideEffectIntent`。

---

## Acceptance Criteria

### 基础
- [x] `GitWorkspace` 实现，worktree 按 task 隔离
- [x] 分支名由 task_id 决定，重复调用幂等
- [x] `pnpm run check` 为绿（142 个测试）

### 核心：真实性
- [x] **两个 Task 各自拿到独立 worktree，互不可见对方的改动**（N1）
- [x] 改动被**真实 commit**，SHA 形如 40 位 hex
- [x] 裸仓库中能看到该分支及其提交
- [x] `remove` 移除工作树但**分支保留在裸仓库里** —— 移除的是工作树，不是历史
- [x] `preservePath` 给出现场路径（`S-FAILED` 靠它让人找到现场）

### 诚实性
- [x] `CreatePullRequest` 仍记 `SideEffectIntent`，**不写空实现**
- [x] 未注入 workspace 时 `CreateBranch` 退回记意图，事件流能区分"真做了"与"只记了意图"

---

## 验收执行记录

**测试**：10 个，全部用**真实 git**，不 mock ——
用假实现验证不了「两个 Task 真的互不可见」这件事。

### ⚠️ 发现：v0.1 e2e 里程碑测试是 flaky 的

本次 `check` 中该测试**失败了一次**，重跑通过（51s 失败 / 146s 通过）。

**根因**：它依赖真实 LLM 产出合法提案。deepseek 的输出有波动，
R-007 虽有重试，但仍可能连续三次不合格。

**这不是缺陷，是这类测试的固有属性** —— 但必须如实记录，
否则下次红了会被当成回归去查代码。

处置建议（留给后续任务，本任务不擅自改）：
1. 把它移出默认 `check`，改为显式命令（`pnpm run test:e2e`）
2. 或保留在 check 中但允许重试
**不建议**放宽 schema 或降低断言强度 —— 那是用假绿换稳定。

### 未做的与为什么

| 项 | 理由 |
|---|---|
| GitHub PR 创建 | 需真实远程与凭据，**本机无法验证**。写了空实现等于假装做过 |
| CI 状态回读 | 同上；CI 是外部事实源 |
| 编排器改用 worktree | `GitWorkspace` 已就绪并接进副作用执行器，但编排器仍用调用方给的固定目录 —— 改造属下一步 |
