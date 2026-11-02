# 生产部署企业内落位

> 对应 GitHub issue [#70](https://github.com/jionpz/keel/issues/70)。
> 本文只写需求、范围与验收；技术设计在各子任务的 `design.md`。

## Goal

让 keel（github.com 谱系，基线 `175b9e9`）在企业内网的生产机**无人值守**跑通
「注册企业仓库 → 提带 label 的 issue → 自动拾取 → 驱动到 PR + CI」的闭环，
全程不需要人工反复执行 CLI。

## Background

当前代码的 4 个缺口按依赖顺序排列：

1. **GHES host 支持**（P0，其余全依赖它）：`src/fact/github-provider.ts` 三处写死 `github.com`。
2. **git 传输认证**（P0）：`git-workspace.ts` 的 clone/fetch/push 裸跑 git，私有仓库无凭据。
3. **常驻 poller**（P0）：issue 驱动仍靠人工 `keel run-issue`。
4. **执行面模型对接**（P1）：缺省模型 `deepseek-v4-flash` 在企业网关不存在。

## Deliverables

| 子任务 | issue 章节 | 依赖 | 状态 |
|---|---|---|---|
| `11-03-ghes-host-support` | §1 | 无（其余依赖它） | planning |
| `11-03-git-transport-auth` | §3 | §1 的 host 解析 | planning |
| `08-29-ingress-poller` | §2 | §1 + §3 | planning |
| `11-03-execution-model-routing` | §4 | 无（可与 §3 并行） | planning |

实施顺序：**§1 → §3 → §2 → §4**。§1–§3 合并后即可在生产机部署；§4 只决定跑哪个模型。

## Cross-child Acceptance

- [ ] `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions / purity / test）。
- [ ] 不设任何新增环境变量时，github.com 路径的行为与 `175b9e9` 完全一致。
- [ ] token 不出现在事件表、日志、错误 detail、git argv 的可读输出中。
- [ ] 四项合入后，在生产机上能用一条命令启动 poller，并在一个 interval 内把带 label 的 GHES issue 驱动到 PR + CI。

## Out of Scope

- Webhook 接入与签名校验（仍按 roadmap 推迟）。
- 多进程 poller / 工作队列并发（v0.1 单进程）。
- GitLab / 其他代码托管平台的 host 支持。
- 企业网关的模型能力探测（只做路由与拒绝，不做自动发现）。

## References

- issue #70 / #69
- `docs/03-domain-model.md`、`docs/08-cross-cutting.md §1.3`
- `.trellis/spec/backend/git-workspace.md`
- `.trellis/spec/backend/harness-adapter.md`
- `.trellis/spec/backend/database-guidelines.md`
