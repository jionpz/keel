# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 三平面结构、边界规则、生成物纪律、import 写法 | ✅ 已填（`08-22-repo-skeleton`） |
| [Database Guidelines](./database-guidelines.md) | 角色身份写入(含 keel_ingress/intake)、SECURITY DEFINER、乐观版本号、错误映射、blob 写入、测试隔离 | ✅ 已填（含 08-27 github ingress） |
| [Error Handling](./error-handling.md) | `Result<T>`、`ErrorKind` 注册表、`retryable` 语义、防假绿 | ✅ 已填（`08-22-repo-skeleton`） |
| [Quality Guidelines](./quality-guidelines.md) | 质量门槛、测试分层、mock 纪律、验收凭据、禁用模式、review 清单 | ✅ 已填(2026-08-23 收尾;08-26 补验收凭据) |
| [Session Context](./session-context.md) | 上下文下行桥：`withPrompt` 只能追加、Adapter 渲染全部 section、`ContextBuilt` 不得说假话 | ✅ 已填（`08-26-v01-closeout`） |
| [Harness Adapter](./harness-adapter.md) | 子进程环境隔离（宿主运行时变量）、同 Run 多轮 state 定位、argv 以当前 CLI 版本为准 | ✅ 已填（`10-25-claude-auth-config`） |
| [Executor Isolation](./executor-isolation.md) | 执行器环境 allowlist、容器规格门禁、真实 Docker 负例探针与证据边界 | ✅ 已填（JT-02A 切片） |
| [Model Routing](./model-routing.md) | 优先级链单一裁决点、`requested_model` 与 spawn 同源、allowlist 启动期预检先于 ingest、claude 不消费 `spec.model` | ✅ 已填（`11-03-execution-model-routing`） |
| [Workspace Diff](./workspace-diff.md) | `collectChanges` 接入编排：采集时机、HEAD 基线、未跟踪文件、事件载体与 fail-closed | ✅ 已填（`10-25-collect-changes-wiring`） |
| [Transition Effects](./transition-effects.md) | `firstRun`/`nextRun` 的可用站点与白名单双向断言、撞键可归因（`existing_status`）、不改键算法的理由、Task 级 timer 三件套的武装/取消对称与 `claimDueTimers` 的 `JOIN task` 防线 | ✅ 已填（`10-26-run-reentry-wallclock`；`11-05-human-review-ttl` 补 timer 章节；`11-07-human-review-ttl-gap` 补存量对账） |
| [Orchestrator Loop](./orchestrator-loop.md) | 停止原因必填（`stopReason`）、阶段态无 run 的证据式判据、单进程前提、只报告不修复 | ✅ 已填（`10-26-orchestrator-stop-reasons`） |
| [Policy Ruleset](./policy-ruleset.md) | `rfc_ready` 放行带（P4 = `risk=low && complexity!=high`）、默认 deny 与严格性偏序不许动、版本号纪律、`default_applied` 覆盖率信号 | ✅ 已填（`11-05-policy-auto-band`） |
| [Run Liveness](./run-liveness.md) | 卡死按无进展判定、`run_liveness` 只授 `keel_control`、supervisor / patrol 分工、成功与失败路径围栏、认领即写 `harness_id`、`KEEL_LIVENESS_MODE` 降级 | ✅ 已填（`11-04-run-liveness-patrol`；`11-05-fail-run-harness-id` 补认领时写身份） |
| [Git Workspace](./git-workspace.md) | Agent 提交用 `-c` 钉死身份与签名、夹具关 gpgsign、`GIT_CONFIG_GLOBAL` 的使用边界、https 传输认证注入（token 来源 `resolveGitHubToken`、按 host 缓存与脱敏） | ✅ 已填（`08-26-v01-closeout`；`11-03` 补传输认证；`11-05-github-token-source` 补 gh 回退） |
| [GitHub Provider](./github-provider.md) | host 解析单一事实源、`KEEL_GITHUB_API_ROOT` 优先级、空白配置 fail-closed、GHES 测试点、token 三来源与启动期 fail fast | ✅ 已填（`11-03-ghes-host-support`；`11-05-github-token-source` 补 token 来源） |
| [Ingress Poller](./ingress-poller.md) | 每仓库 `issue_label`、分页与 `truncated`、轮内去重、`StopToken` 订阅制、日志脱敏 | ✅ 已填（`08-29-ingress-poller`） |
| [CLI Lifecycle](./cli-lifecycle.md) | 分发层统一关池（`finally`）、常驻循环 SIGTERM 必跳出、监听不叠加、关池失败不改退出码、常驻角色单实例 advisory lock | ✅ 已填（11-04 生命周期收口；`11-05-poller-single-instance` 补单实例锁） |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | ⏳ 暂缓 —— 尚无日志代码 |

> **⏳ 暂缓的 logging 是刻意留空的**,不是遗漏。
> 本项目的规则是「记录现实而非理想」:日志尚无任何代码,
> 现在写等于凭空发明约定,而子 agent 会照着它写出与实际不符的代码。
> 等 v0.1 有了真实实现再填。frontend 各文件同理(无前端代码)。

---

## 语言

代码注释与本 spec 用**中文**；标识符、类型名、字段名、命令用英文。

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
