# 实施进度：JT-01 只读影子链路

**日期**：2026-11-10。当前已实现可运行的协议与后台队列，仍未通过真实推理端到端验收；不是整个生产方案已完成。

## 已实现

- jstack `managed-export` 从自身 Question 路线、阶段表和只读 provider 导出协议包；文件缺失、路线不兼容或路径越界时拒绝。
- Keel 校验并持久保存包内容与摘要，既有任务不跟随本地包文件更新；仅支持 `investigation / execute`，不假装支持 L/XL 路线。
- `managed investigate/status/questions/answer/worker`：创建持久任务、查看问题和建议、接受真实本机操作者答复、后台自动继续。
- 调查执行产生 `read_files`、`waiting_decision` 或带引用的 `completed` 提案。模型没有原生工具；Linux FD 锚定读取只允许项目内受控普通文本，拒绝软链、隐藏/凭据路径、二进制和越界。
- 每个人工问题先执行天问，保存建议或失败原因，再进入人工队列。**JT-01 是影子模式**：所有此类问题仍等真实用户；项目长期历史、摘要和委托代批尚未接入。
- 任务/问题/尝试/审计独立于旧 `S-*` 状态机；旧 poller/driver 不驱动它们。后台认领使用 PostgreSQL 行锁、租约和 fencing token，过期可重取、迟到结果不可提交。
- 答复与任务 READY 状态在同一事务提交；重复相同答复幂等，不同答复冲突；等待期间不占用模型会话。worker 轮询会自动恢复，无需用户再运行 run-task。
- 输出和引用校验、有限调用预算、连续协议/推理错误重试、上下文持久快照和终态不可变约束。

## 本机试运行

前提：Node 24、依赖已安装、PostgreSQL 全部迁移；已安装所选 OMP/Claude CLI 并配置相应推理凭据。凭据不在命令行传入。以下是开发环境命令，`REPO_UUID` 和 `QUESTION_UUID` 取实际输出。

```bash
# jstack 仓库：导出只读调查包
./jstack managed-export > /tmp/jstack-investigation.json

# Keel 仓库：指定你自己的开发数据库并迁移
DATABASE_URL=postgres://localhost/keel_dev pnpm run db:migrate

# 为已有、由管理员绑定本地目录的 repo 创建调查
pnpm run keel managed investigate --repo REPO_UUID \
  --question '说明这个项目如何启动，并给出文件依据' \
  --package /tmp/jstack-investigation.json

# 常驻；根据实际安装选择 omp 或 claude
pnpm run keel managed worker --harness omp

# 另一个终端查看与答复；后台 worker 会自行接续
pnpm run keel managed questions --task TASK_UUID
pnpm run keel managed answer QUESTION_UUID --text '我的决定'
pnpm run keel managed status TASK_UUID
```

注册本地目录沿用已有 `register-repo --local-path`；没有绑定的 repo 不能创建此类任务。`managed worker --once` 只推进一次推理，可用于诊断；它不是“直接跑到终态”。

当前首发仅 Linux（要求 `/proc/self/fd`），单 task 默认最多 12 次模型调用，每次 90 秒并有清理宽限；上下文和文件读取有硬上限。未安装 Harness 时 worker 在认领前退出，任务保留 READY。

## 验证边界

本轮验证结果：

- Keel 新增 21 项确定性测试通过。
- 隔离 Node 24 / PostgreSQL 16 环境中，`pnpm run check && pnpm run build` 退出码 0；69 个测试文件，1002 项通过、5 项因缺少原生推理 CLI 跳过。
- jstack `./jstack check` 通过，包含 4 项 managed 导出测试与原有 123 项 hook/stage 检查；缺少 Claude CLI 的 manifest live 校验明确跳过。
- 实际 `jstack managed-export` 的产物被 Keel schema 接收，CLI 帮助与文档链接检查通过。

隔离运行用于排除云沙箱在 `/tmp/.git` 注入元数据对原有项目根目录测试的干扰，未改写或跳过该断言。精简测试镜像补齐了 Git 与 procps；运行项目检查未安装/改变项目依赖或锁文件。

确定性回归使用真实 PostgreSQL、临时文件和固定候选结果，验证协议、来源、租约、重复答复、恢复及权限，不将这些夹具当作真实模型验收。jstack 导出包也由 Keel schema 实际接收验证。

当前环境尚无 `omp` / `claude` 及推理凭据，真实问题 → 模型查证 → 天问建议 → 人工答复 → 模型报告的验收仍待运行。不存在已部署的生产服务或已经获得的新合并/部署权限。

## 尚未实现

JT-02 至 JT-07：既有决定自动代答、正式委托策略、跨任务项目决定与摘要、完整工程路线/多 ticket、写操作网关、审批与撤销闭环、统一 daemon/控制台接入、备份演练、真实评测及受限生产试运行。不能把 JT-01 当作这些能力已经交付。
