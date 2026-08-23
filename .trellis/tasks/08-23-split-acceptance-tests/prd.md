# 分离验收测试与回归测试

> 父任务：`08-23-v01-closed-loop`

## Goal

把**依赖真实 LLM 的验收测试**从默认 `check` 中分离出去，
同时**不降低**任何确定性断言的强度。

## Problem

`src/e2e/v01-criterion.test.ts` 依赖真实 LLM 产出合法提案，因此**天然 flaky**：
上一轮 `check` 中失败一次、重跑通过（51s 失败 / 146s 通过）。

**这比看起来严重**：项目最核心的资产是那套「让违规成为 CI 失败」的机制
（四条约束 + 反例验证纪律）。一旦 `check` 开始因为**非代码原因**变红，
人就会开始忽略它 —— 而那正是 `.trellis/spec/backend/error-handling.md`
里写的失效模式：**检查一旦不可信，就等于没有检查**。

## 这不是「不可用就跳过」

项目明确禁止那种做法（那是假绿）。两者的区别：

| | 假绿 | 本任务 |
|---|---|---|
| 行为 | 条件不满足时**静默跳过**，输出与通过一样 | 移到**显式命令**，不满足时**明确失败** |
| 后果 | 没人知道它没跑 | 验收时必须跑，且结果被记录 |

## Requirements

### R1 · 测试分层

| 层 | 命令 | 内容 | 特性 |
|---|---|---|---|
| 回归 | `pnpm run check` | 全部确定性测试 | 必须永远绿 |
| 验收 | `pnpm run test:acceptance` | 依赖真实 LLM 的端到端 | 花钱、慢、有波动 |

**`check` 中不得因此丢失任何确定性断言。**

### R2 · 验收结果必须被记录

验收测试通过后，结果（时间、路径、耗时）记入任务文档。
否则「上次验收是什么时候、结果如何」会无人知晓。

### R3 · 编排器改用 worktree

`GitWorkspace` 已就绪但编排器仍用调用方给的固定目录。
接上后每个 Task 在自己的 worktree 里跑（`N1`）。

## Acceptance Criteria

- [x] `check` 中不含依赖真实 LLM 的测试，且**仍为绿**
- [x] `test:acceptance` 存在且能跑通 v0.1 判据
- [x] 分离的**理由写在代码注释里**，不是只在 commit message 中
- [x] CI 跑 `check`；验收测试**显式说明**为何不在 CI 中
- [x] 编排器为每个 Task 创建独立 worktree，e2e 中可验证
- [x] 确定性断言数量**未减少**（分离前后对比）

---

## 验收记录

### 2026-08-23 · `pnpm run test:acceptance`

| | |
|---|---|
| 结果 | **2 passed**，188.3s |
| `v01-criterion` | 155.8s |
| `session-milestone` | 31.9s |
| Harness | 本机 OMP + deepseek-v4-flash |

走过的路径（一次跑通，无重试）：

```
T-002(派发) → T-004(pm) → T-011(rfc_draft) → T-012(Policy auto_develop)
  → T-017(develop) → T-018(qa) → T-021(review) → T-024(外部 CI passed)
```

**与上次验收的差别**：这次是在**每 Task 独立的 worktree** 里跑完的（R3），
develop 的改动提交到了 `ai/task-<id>` 分支。上次用的是调用方给的固定目录。

### 断言数量对比

| | 分离前 | 分离后 |
|---|---|---|
| `check` 里的 `expect` 总数 | 56 | 42 |
| 其中依赖真实模型 | 24 | **0** |
| **确定性断言** | **32** | **42** |

确定性断言不减反增 10 条 —— 新增的 `orchestrator-workspace.test.ts` 用桩 Adapter
把 worktree 隔离（`N1`）钉成了确定性断言，这在此前只能靠花钱的验收测试间接覆盖。

### `check` 耗时

146s → **21s**。省下的几乎全是等模型的时间。

---

## 过程中抓到的问题

### 1. `mergeConfig` 让验收命令一个测试都跑不到

验收配置最初写成 `mergeConfig(base, {...exclude: []})`。
但 `mergeConfig` 对数组是**拼接**而非覆盖，基础配置里那条
「排除 `*.acceptance.test.ts`」被继承了下来 —— 于是 `test:acceptance`
匹配到 0 个文件。

**这正是本任务要消灭的那种假绿**，而且藏在为了消灭假绿而写的代码里。
抓到它的是反例验证（故意把验收测试改名，看命令报什么错），
不是通读代码。改法：抽出 `vitest.shared.ts`，两套配置各自显式声明 `exclude`。

顺带加了 `passWithNoTests: false` —— 匹配不到测试必须是错误。

### 2. 编排器切到 worktree 后会丢掉 Agent 干的活

`CleanWorkspace`（进 `S-DONE` 时触发）是 `worktree remove --force`，
而编排循环**从没提交过**任何东西。两者接上的那一刻，
develop 阶段改的文件会随工作树一起消失。

超出 R3 原本的字面范围，但不补上的话 R3 就是一次功能退化，因此一并做了：
每个 run 成功后 `commitAll` 到该 Task 的分支。分支留在裸仓库里，
所以清理工作树不损失历史 —— 这正是 `git-workspace.ts` 当初的设计意图。

对应断言：`orchestrator-workspace.test.ts` 的第二条。
反例验证过 —— 去掉 `commitAll` 后它变红。
