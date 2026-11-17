# ADR-0014 · managed 使用私有 Git 副本与沙箱成员回收

**Status**: Accepted — owner 已确认独立 Git 副本方案；实际 workflow 的恢复另行决定。
**Date**: 2026-11-17
**Related**: ADR-0011；GitHub #144。

## Context

managed 原来为节点创建 linked worktree，并允许沙箱读写其 common Git 目录。
这会把宿主其他工作树的管理记录、refs 和配置暴露给执行器。真实沙箱夹具已证明：
其他工作树的普通文件不可读，但其共同 Git 管理目录可写；Git 的 prune dry-run
还会把沙箱外实际存在的工作树判为失联。该机制不等于已经查明现场记录丢失的触发命令。

只终止 Harness 的进程组也无法回收使用 setsid / 双重 fork 的后台验证。
阶段结束后，这些进程可能继续改动保留工作区，使恢复点与证据脱节。

## Options

- 继续共享 common Git 目录、细分其写权限：提交仍会涉及共享 refs、配置与对象管理，
  各种 Git 维护命令需要额外特例，边界难以证明。
- 为每个节点建立私有仓库，按准确 commit 传递依赖结果：对象传输与工作区存储增加，
  但无需给执行器开放任何宿主 Git 管理目录。

## Decision

1. 采用私有仓库。Control Plane 使用 `git clone --no-local --no-checkout` 从只读源
   复制，再在副本创建节点分支。Git 对象传输避免复制 hooks、源配置、硬链接和
   alternates。源可以是 linked worktree，但永远不作为该节点的可写执行工作区。
2. 下游从已归档前驱的私有仓库复制准确输出 commit；多依赖仍要求一个输出覆盖全部
   祖先，不做隐式合并。下游成果不需要先写回宿主仓库或发布到远端。
3. 绑定、阶段前后检查和 OS 沙箱构造均拒绝外置 `.git`、commondir、alternates、
   Git 管理目录内的符号链接、硬链接与特殊文件。存量 linked worktree 保留并拒绝执行，
   不静默迁移、重绑或丢弃 WIP。
   规划、调查与天问显式使用只读源模式；linked 源的文件和共同 Git 元数据均不可写。
4. macOS profile 将信号权限限定为 `same-sandbox`。每次真实 Harness 启动前先启动
   同一沙箱内的 supervisor，通过 SIG0 判断内核沙箱成员，再停止并回收全部成员。
   会话、进程组、父 PID 和环境变量变化均不改变继承的沙箱身份。独立启动的其他沙箱
   即使使用相同 profile，也没有发信号权限。
5. supervisor 正常结束、收到终止信号或宿主持有的 stdin 管道关闭时都执行回收。
   Control Plane 每 500ms 检查任务状态、代次与租约，变化或无法确认时通过
   `AbortSignal` 撤回阶段；Execution Plane 不读取或写入 Fact Plane。
   supervisor 无法确认回收时暂停并保留现场。宿主 Git 检查禁用 workspace 配置的
   fsmonitor、hooks、外部 diff/textconv 与 replace 对象。复制节点和受控传输使用控制层
   新建的临时 Git 配置视图；push 只读取源对象库，不加载源配置或 refs，防止工作区通过
   URL 重写、传输命令、代理或 pre-push hook 在宿主执行脚本或改变批准的传输目标。
6. 紧接有证据的 RUN_TIMEOUT、范围内且干净的已提交恢复点，可由执行器重新确认完成，
   然后进入正式 verify。普通空执行和仍有 WIP 的恢复不能重复确认原输入蒙混过关。
   verify、review、land、archive 及授权门禁均继续执行。

## Consequences

- 每个节点保存自己的对象库；磁盘开销高于 linked worktree，换取可证明的写入边界。
- 数据库字段与 CLI 的 `worktree_path` / `--worktree-root` 名称保留，表示工作区路径，
  不再表示 Git linked worktree。
- macOS supervisor 依赖系统 `/usr/bin/pgrep` 只枚举 PID，不读取宿主 argv/env。
  `/bin/ps` 是 setuid 程序，不能在沙箱内启动，不能拿它充当成功的回收证明。
- 该方案仍是个人单用户进程沙箱；不能声称隔离于宿主内核或防御拥有宿主权限的攻击者。
  强制杀死 supervisor 本身等恶意破坏不等于正常阶段取消或服务退出。
- 不改变 legacy-v01 的 `GitWorkspace` managed/attached 存储模式，不部署新服务，
  不恢复 #134/#135，不启动 JT-07。

## Verification

私有仓库与恢复门禁由 `ticket-workspace.test.ts`、`ticket-runtime.test.ts` 和
`workflow-runtime.test.ts` 覆盖；真实 macOS 写入与进程负例由
`os-sandbox.isolation.test.ts` / `process-supervisor.isolation.test.ts` 覆盖。
完整命令与准确提交的 CI 证据写入 #144 和对应 PR；设计采用不能替代检查通过。
