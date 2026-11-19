# Keel CI / 候选交付契约

> **核心区别**：`CI 成功`、`候选包可运行`、`真实模型验收通过`、`生产准入` 是四个独立命题；不能把前者冒充后者。

## 真实流水线

唯一 GitHub Actions 工作流：[CI](../../../.github/workflows/ci.yml)。

```text
pull_request (所有目标分支)           push(main)
                │                        │
                └────────┬───────────────┘
                         │
       ┌─────────────────┴────────────────┐
       │                                  │
  check (PG16 + C1-C4 + tests + build)  isolation (Docker 负例)
       │                                  │
       └─────────────────┬────────────────┘
                         ▼
            package (仅生产依赖 + CLI smoke)
                         │
                PR: 只验证，不上传
                main: 上传带 commit SHA/sha256 的候选包
                         │
                         ▼
             人工验收 / 生产准入（**不自动触发**）
```

### 每一道门证明什么

| 门 | 自动验证 | **不能**推出 |
|---|---|---|
| `pnpm run check` | lint、TypeScript、架构边界 C1–C4、确定性测试、`tsc` 构建、已构建 CLI 的 `--help` 烟测 | 真实模型效果，完整宿主沙箱，部署就绪 |
| `pnpm run check:isolation` | Docker / 文件权限的确定性隔离负例，单独 job | 所有 OS 的 managed 沙箱已经完整实现 |
| `pnpm run check:package` | 构建 `dist`，仅按 `dependencies` 安装产物运行依赖、校验迁移 CLI、启动构建后 Keel CLI | 已在生产环境通过迁移、兼容真实 Harness 或客户数据 |
| `main` candidate artifact | 同一 commit 先经过三道门；打包 `dist/`、`migrations/`、package/lockfile、SHA 和 checksum | npm 正式发布、生产部署、自动合并或自动放权 |

`check:package` 的意义不是再跑一遍单测，而是在**没有 devDependencies** 的隔离目录里证明程序真的能启动。`pg`、`ajv`、`ajv-formats` 和生产迁移 CLI `node-pg-migrate` 属于运行依赖，其余测试/类型/编译工具是开发依赖。每次改依赖都必须保证生产安装通过。

### 触发器、资源与权限

- PR 只触发 `pull_request`；只有整合后的 `main` 提交触发 `push`。同一 feature SHA 不再跑两份相同的 push/PR 检查。
- PR 更新会取消同一个 PR 的过期工作流；`main` 的检查**不会**自动取消。保持每个已合入 commit 的审计轨迹。
- `GITHUB_TOKEN` 仅授 `contents: read`，checkout 不持久化写凭据。第三方 Actions 固定到**确切提交 SHA**，由 Dependabot 周期性发起升级 PR。
- PostgreSQL 服务是 16；`pg_dump`/`pg_restore` 必须明确选 16 客户端，防止较新客户端写入 PG16 不认识的 `transaction_timeout`（2026-11-14/15 的历史失败根因）。
- check、isolation、package 是独立 job。必须在仓库分支保护中把三者设为 **required checks**，否则「工作流存在」不等于「合并时被强制」；仓库规则本身需由有相应权限的维护者核实。

## 本地重现

```bash
pnpm install --frozen-lockfile
# 需要本机可用、已迁移的 PostgreSQL 测试库，KEEL_DATABASE_URL 指向它
pnpm run check
# Docker 负例需在支持 Docker 的主机另跑
pnpm run check:isolation
# 编译、在临时目录 prod-only 安装并执行 CLI
pnpm run check:package
```

`pnpm run check` 会保留本地/CI 的统一命令约定。不把需要真实模型、GitHub 写权限、成本或特定宿主能力的验收放进 PR CI；这些属于 [验收分层](../../../src/acceptance/README.md)。

## 候选包与生产准入

当整合后的 `main` 通过三道门，Actions 上传 `keel-candidate-<commit>`（默认保存 14 天），包含可下载的 `keel-<shortsha>.tar.gz` 和 `*.sha256`。包里**不含** `node_modules`、数据库、凭据、环境变量或旧工作区；部署环境需使用 Node 24 / pnpm 10 安装运行依赖，并配置 PostgreSQL、宿主沙箱和授权。

候选包示例（仍然不是部署）：

```bash
shasum -a 256 -c keel-<shortsha>.tar.gz.sha256
tar xzf keel-<shortsha>.tar.gz
cd keel
pnpm install --prod --frozen-lockfile
node dist/cli/index.js --help
```

**自动 CD 暂不启用**：发布 / 部署要额外核对真实 `doctor` 支持矩阵、JT-07 的 [试运行门槛](./trial-readiness.md)、真实模型/CI/GitHub 行为、数据库备份与恢复演练、`UNCERTAIN` 动作回查，以及明确 owner 授权。当前 Linux 读取与 macOS 写沙箱能力仍有跨平台缺口；**候选包存在不改变生产准入状态**。正式部署目标、环境与回滚方案确定后，再增加需 approval 的部署 job，而不是假设 `main` 绿色就能直接发布。
