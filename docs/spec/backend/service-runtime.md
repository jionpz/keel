# 统一后台服务、恢复与备份

**状态**：JT-06 实现。产品范围是**单用户、单 owner、单 PostgreSQL**；不包含多租户、账号体系或 HTTP 多用户认证。

## 1. 单一入口

`keel serve` 是唯一常驻入口，默认同时运行：

| 角色 | 职责 |
|---|---|
| `ingress` | 扫描已注册 GitHub repo 的 issue，驱动 legacy-v01；`--no-ingress` 关闭 |
| `managed` | 天问决策、调查、ticket 与 workflow 四类工作轮转推进 |
| `memory` | 只生成项目摘要 DRAFT，不自动发布 |
| `maintenance` | timer drain、人工 TTL 与停滞 run 巡检 |
| `outbox` | 回查 `UNCERTAIN` 动作并运行受控 action gateway |
| `checks` | required checks 轮询 |
| `service` | 统一生命周期与自身心跳，不是业务组件 |

`--no-ingress` 只适用于明确只处理已持久化 managed 工作的运维场景。启用 ingress
时，启动预检会从已注册仓库的 remote 推导 GitHub host；缺凭据直接写
`ingress=BLOCKED/AUTH_FAILED` 并以非零码退出。独立 `poller` 与 `serve` 启用
ingress 时通过会话锁互斥。

## 2. 进程与锁

`serve` 使用 PostgreSQL 会话级 advisory lock：

- `keel-service`：同一数据库只允许一个统一服务；
- `timer-worker`：维护组件不得与独立 timer worker 双跑；
- `poller`：仅在 ingress 启用时持有，避免与独立 poller 竞争。

锁绑定专用数据库连接，进程崩溃或 `kill -9` 后由 PostgreSQL 在连接断开时释放。
锁不替代队列租约；业务 claim 仍使用数据库租约和 fencing token。

## 3. 健康与退避

`worker_health` 在 JT-06 增量扩列：`instance_id`、`pid`、`status`、
`reason_code`、`detail`、`checkpoint`、`started_at`、`last_success_at`。

状态为 `STARTING / RUNNING / DEGRADED / STOPPING / STOPPED / BLOCKED`。
每类组件独立运行：

- 一个组件异常只把自己写成 `DEGRADED`，附稳定原因码和截断后的 detail；
- 指数退避有上限，空闲轮询和成功 tick 会清零失败计数；
- 长 tick 期间由 `withPeriodicHeartbeat` 刷新该组件心跳；
- `service` 自身另有周期心跳，避免它的长时间运行被误判为 `STALE`；
- 健康写入失败只记日志，不改变已开始的业务 tick。

managed 的四类队列共享轮转游标；有决策待办不意味着可以饿死 ticket/workflow。
可预期的单队列错误保留在 `failed_phases`，该组件仍尝试其他队列，并以
`DEGRADED` 上报，直到失败队列自身恢复。未预期异常仍走组件退避。

`keel service-status` / `keel service-health` 只读 `worker_health` 与队列表；
查询本身不认领、不调用模型、不访问 GitHub。必需组件为
`service/managed/memory/maintenance/outbox/checks`，`ingress` 是可选组件。
是否存在可选组件从 `service` checkpoint 的 `components` 读取，因此
`--no-ingress` 后遗留的旧 `ingress=STOPPED` 行不会把服务判成不健康。

## 4. 信号与安全边界

`SIGTERM` / `SIGINT` 的处理顺序：

1. 置停止令牌，组件不再开始新 tick；
2. 当前 tick 或长驻扫描自然收尾，不中断正在进行的模型调用或外部动作；
3. ingress 等待所有在途驱动结束；
4. 写入各组件 `STOPPED` 与最终 `service=STOPPED`；
5. 释放锁并关闭连接池。

进程被 `SIGKILL` 时没有机会执行 2–5 步；数据库租约、持久 outbox 和
`UNCERTAIN` 回查负责恢复。不得用进程内状态假装已提交。

## 5. 公平调度与 fencing

ticket、workflow 和 outbox 的 claim 都按项目先取最久未推进的一条，再在
这些项目候选中取最旧的一条。这样单个项目不能连续占满所有认领机会。
claim 仍在数据库事务中使用 `FOR UPDATE SKIP LOCKED`；实际阶段提交必须
携带当前租约 token 或 fence。旧 worker 的迟到结果不会覆盖新认领者。

失败重试、租约过期与死信状态沿用既有契约：

- ticket/workflow 的 attempt 有上限，耗尽后 `FAILED`；
- outbox 的 `EXECUTING` 结果未知时转 `UNCERTAIN`，先回查远端；
- `PENDING/LEASED/EXECUTING/UNCERTAIN/BLOCKED` 都是健康快照中的待恢复工作。

## 6. 备份

```bash
keel backup --out /path/to/backup \
  [--blob-dir /path/to/blob]
```

备份流程：

1. 在 `REPEATABLE READ READ ONLY` 事务中 `pg_export_snapshot()`；
2. 用 `pg_dump --snapshot` 生成 custom dump（保留权限，省略 owner）；
3. 从同一快照读取队列、待答问题、工作流包摘要与外部关联 ID；
4. 复制被 artifact、ticket stage、workflow evidence 引用的内容寻址 blob；
5. 写 `manifest.json` 与 `manifest.sha256`，以原子 rename 发布目录。

备份目录不允许覆盖。manifest、DB dump、blob 任一摘要不一致即 fail-closed。
凭据不进入备份正文；连接串只拆成 libpq 环境变量，不放进子进程 argv。
URL 查询参数中的 `host`（含 Unix socket 目录）、`port`、`user`、`password`
优先于 authority；`pg_dump` 和 `pg_restore` 必须与应用连接同一数据库。

工作流包的 `digest` 按其协议计算：ticket/route 排除自身 `content_digest` 字段，
调查包使用整包摘要。manifest 另存完整正文的 `body_sha256`，两者不能混用。
ticket/route 同时校验 schema、来源和内嵌内容摘要；正文或内嵌摘要被篡改时拒绝备份，
不能退回整包摘要绕过协议校验。

## 7. 隔离恢复校验

```bash
keel restore-verify --backup /path/to/backup [--keep-database]
```

恢复校验：

1. 校验 manifest 签名、DB dump 与全部 blob；
2. 创建独立临时数据库并 `pg_restore`；
3. 重新计算表计数、状态分布、待答/待处理队列、`managed_package` body 摘要、
   blob 引用和外部关联；
4. 与备份 manifest 逐项比较；成功默认删除临时库，失败保留现场。

`resume` 结论不是“自动重放许可”：

- `EXECUTING/UNCERTAIN` → `BLOCKED_UNTIL_RECONCILE`，先回查远端；
- 有外部动作且缺少 GitHub 凭据 → `BLOCKED_CREDENTIALS`；
- 有待答问题或决定 → `WAITING_HUMAN`；
- 否则 `READY`，启动前仍须通过 harness/凭据预检。

恢复只保证数据库、工作流包摘要、checkpoint/blob 和外部 ID 一致；不会自动
创建 PR、重发 push、替用户回答问题或把 `uncertain` 改成成功。

## 8. 验收命令

```bash
pnpm run check
pnpm run build

# 变更迁移后，使用全新库：
DATABASE_URL=postgres://localhost/<fresh-db> pnpm exec node-pg-migrate up
DATABASE_URL=postgres://localhost/<fresh-db> pnpm exec node-pg-migrate down 1
DATABASE_URL=postgres://localhost/<fresh-db> pnpm exec node-pg-migrate up
```

确定性回归覆盖：

- 组件故障隔离、指数退避、SIGTERM 收尾、`service` 长任务心跳；
- 健康查询无副作用、缺失/陈旧/降级、队列与待答统计；
- ticket/workflow/outbox 跨项目公平认领；
- 真实 PostgreSQL 备份、隔离恢复、manifest/DB/blob 篡改、缺凭据与
  `UNCERTAIN` 恢复阻塞。
