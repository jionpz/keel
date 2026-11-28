# 后端开发规范

> 按**当前实现和测试**编写；这里仅导航到能说明实际约束的文档，不给每个条目复制一份会过期的「已填/完成日期」。

改动前：先读 [文档权威来源](../../README.md) 和对应的实现与测试。managed 阶段/状态看 [当前状态机](../../managed-state-machine.md)，旧 `S-*` 状态只能用于 `legacy-v01`。

## 规范索引

| 规范 | 约束与适用场景 |
|---|---|
| [Directory Structure](./directory-structure.md) | 三平面结构、边界规则、生成物纪律、import 写法 |
| [Database Guidelines](./database-guidelines.md) | 角色身份写入(含 keel_ingress/intake)、SECURITY DEFINER、乐观版本号、错误映射、blob 写入、测试隔离 |
| [Error Handling](./error-handling.md) | `Result<T>`、`ErrorKind` 注册表、`retryable` 语义、防假绿 |
| [Quality Guidelines](./quality-guidelines.md) | 质量门槛、测试分层、mock 纪律、验收凭据、禁用模式、review 清单 |
| [Session Context](./session-context.md) | 上下文下行桥：`withPrompt` 只能追加、Adapter 渲染全部 section、`ContextBuilt` 不得说假话 |
| [Harness Adapter](./harness-adapter.md) | 子进程环境隔离（宿主运行时变量）、同 Run 多轮 state 定位、argv 以当前 CLI 版本为准 |
| [Executor Isolation](./executor-isolation.md) | 执行器环境 allowlist、容器规格门禁、真实 Docker 负例探针与证据边界 |
| [Model Routing](./model-routing.md) | 项目不预设模型、部署方 profile 按 harness/stage/role 配置、managed 阶段墙钟上限 `timeout_s`、managed 与 legacy 共用解析、`requested_model` 与 spawn 同源、allowlist 启动期预检先于 ingest |
| [Workspace Diff](./workspace-diff.md) | `collectChanges` 接入编排：采集时机、HEAD 基线、未跟踪文件、事件载体与 fail-closed |
| [Transition Effects](./transition-effects.md) | `firstRun`/`nextRun` 的可用站点与白名单双向断言、撞键可归因（`existing_status`）、不改键算法的理由、Task 级 timer 三件套的武装/取消对称与 `claimDueTimers` 的 `JOIN task` 防线 |
| [Orchestrator Loop](./orchestrator-loop.md) | 停止原因必填（`stopReason`）、阶段态无 run 的证据式判据、单进程前提、只报告不修复 |
| [Policy Ruleset](./policy-ruleset.md) | `rfc_ready` 放行带（P4 = `risk=low && complexity!=high`）、默认 deny 与严格性偏序不许动、版本号纪律、`default_applied` 覆盖率信号 |
| [Run Liveness](./run-liveness.md) | 卡死按无进展判定、`run_liveness` 只授 `keel_control`、supervisor / patrol 分工、成功与失败路径围栏、认领即写 `harness_id`、`KEEL_LIVENESS_MODE` 降级 |
| [Git Workspace](./git-workspace.md) | Agent 提交默认身份与关闭签名、可选仓库身份/header/正则或 hook、拒绝回灌与人工审查、https 传输认证注入 |
| [GitHub Provider](./github-provider.md) | host 解析单一事实源、`KEEL_GITHUB_API_ROOT` 优先级、空白配置 fail-closed、GHES 测试点、token 三来源与启动期 fail fast |
| [Ingress Poller](./ingress-poller.md) | 每仓库 `issue_label`、分页与 `truncated`、轮内去重、`StopToken` 订阅制、日志脱敏 |
| [Issue Writeback](./issue-writeback.md) | 仓库回写开关、持久投递、v1 评论标记、失败重试、澄清答复与 PM 1.1 产物 |
| [CLI Lifecycle](./cli-lifecycle.md) | 分发层统一关池（`finally`）、常驻循环 SIGTERM 必跳出、监听不叠加、关池失败不改退出码、常驻角色单实例 advisory lock |
| [Decision Acceptance](./decision-acceptance.md) | 项目决定/委托版本、E3/E1 确定性接纳、request revision CAS、唯一决议与角色权限 |
| [Project Memory](./project-memory.md) | 项目记忆事实源、版本化摘要、epoch/水位增量、检索预算、回滚与人工规则提升 |
| [Ticket Execution](./ticket-execution.md) | jstack 单 ticket 固定包、阶段门禁、阶段墙钟与租约、execute/verify 检查分工、verify/review 证据绑定、must-stop DecisionRequest、scope 检查与 branch_ready/pr_ready 边界 |
| [Workflow Routing](./workflow-routing.md) | jstack XS/S/M/L/XL route 包、依赖图校验、节点调度、scope、证据复用、archive 与双投影 |
| [Action Gateway](./action-gateway.md) | action intent / ExecutionPermit / 持久 outbox、受控 push 与 PR、required checks 与准确 SHA 的 `pr_ready` |
| [PR Description](./pr-description.md) | PR 标题模板回退与 header 校验、问题/根因/改动/验证章节、artifact 来源、兼容标记 |
| [Service Runtime](./service-runtime.md) | 单一 `serve` 入口、角色健康、公平调度、SIGTERM 边界、一致性备份与隔离恢复校验 |
| [Trial Readiness](./trial-readiness.md) | `doctor` 支持矩阵、单 owner 试运行账本、7 天/30 代决/5 完成任务门槛与证据边界 |
| [可靠性故障回放](./reliability-replay.md) | 隔离回放入口、证据记录和可靠性指标口径 |

**暂无统一日志模块规范**：不保留没有对应实现的空白 `logging-guidelines.md`。已有日志脱敏、健康检查和审计要求以各运行模块的实现、测试及上表具体规范为准。

**文档语言**：中文；代码标识符、类型、命令保持英文。
