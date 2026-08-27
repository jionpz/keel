# 验收测试

> 这些测试**不在默认 `pnpm run check` 中**。用 `pnpm run test:acceptance` 显式运行。

## 为什么分离

判断标准只有一条：

> **断言是否依赖模型「说了什么」。**

| | 归属 | 例 |
|---|---|---|
| 依赖模型输出内容 | 本目录（验收） | 六个阶段都要产出合法 JSON 提案 |
| 只依赖工具行为 | `check`（回归） | omp 会不会加载仓库里的扩展；成本字段是否非空 |

后者虽然也真调 omp、也花钱，但**结果是确定的** —— 留在 `check` 里。

## 分离的真正理由

不是「慢」也不是「花钱」，而是：

> **一个 flaky 测试留在默认 check 里，会侵蚀 check 本身的可信度。**

本项目最核心的资产是那套「让违规成为 CI 失败」的机制
（四条架构约束 + 反例验证纪律）。一旦 `check` 开始因为**非代码原因**变红，
人就会开始忽略它 —— 而 `.trellis/spec/backend/error-handling.md` 写得很清楚：
**检查一旦不可信，就等于没有检查。**

实测依据：`v01-criterion` 在一次 `check` 中失败、重跑通过
（51s 失败 / 146s 通过）。根因是 deepseek 输出有波动，
R-007 的重试仍可能连续三次不合格。

## 这不是「不可用就跳过」

项目明确禁止那种做法。区别在于：

| | 假绿 | 本目录 |
|---|---|---|
| 条件不满足时 | **静默跳过**，输出与通过一样 | **明确失败** |
| 是否有人知道没跑 | 不知道 | 知道 —— 它是独立命令，验收时必须跑 |

**禁止**为了让这些测试稳定而放宽 schema 或降低断言强度 ——
那是用假绿换稳定，正是本项目一路在避免的事。

## 本目录有什么

| 文件 | 验的是什么 | 额外前置 |
|---|---|---|
| `v01-criterion.acceptance.test.ts` | seed 的 S-NEW task 在无人干预下走到 S-DONE(CI 由测试注入) | 无 |
| `github-pr.acceptance.test.ts` | push → 真实建 PR → 幂等复用 → 真实 CI 回读 | `KEEL_GITHUB_TOKEN`、`KEEL_TEST_REMOTE_REPO` |
| `issue-e2e.acceptance.test.ts` | **真实 GitHub Issue** → S-DONE + 通过 CI 的真实 PR,事件流 T-001 起 T-024 终 | 上述两项 + 已登录的 `gh` CLI(创建/关闭验收用 Issue) |

`issue-e2e` 与 `v01-criterion` 的差别只有一处,却正是 v0.1 判据里最后补上的那一环：
**「一条真实反馈进入系统」的「进入」**。前者事件流从 `T-001` 开始，后者从 `T-002`
开始（它的 S-NEW task 是 seed SQL 直插的）。

### 凭据

详细矩阵见 `.trellis/spec/backend/quality-guidelines.md` §验收测试的凭据。要点：

| 环境变量 | 用途 | 要求 |
|---|---|---|
| `OPENCODE_API_KEY`（或 `DEEPSEEK_API_KEY`） | omp 推理网关 | 任一即可 |
| `KEEL_GITHUB_TOKEN`（或 `GITHUB_TOKEN`） | PR 创建 + CI 回读（REST API） | fine-grained PAT：Contents RW + Pull requests RW |
| `KEEL_TEST_REMOTE_REPO` | 真实远程仓库 | 对上述 token 可写 |

两个已实测的陷阱：

- **Cloud Agent 的 `ghs_` token 能 push 不能开 PR**（403）——
  `v01-criterion-github` 的 beforeEach 预检会在起编排器之前失败并打印此信息；
- **不要**在跑验收时设 `GIT_CONFIG_GLOBAL=/dev/null`：
  那会一并屏蔽 `gh` 的 credential helper，push 失去鉴权。
  该变量只用于 `pnpm run check`（隔离操作者的签名等全局配置）。

跑法：

```bash
export KEEL_GITHUB_TOKEN="$(gh auth token)"
export KEEL_TEST_REMOTE_REPO=https://github.com/<owner>/<repo>
pnpm run test:acceptance
```

缺任一前置时 `issue-e2e` **明确失败并打印怎么补**，不跳过。

## 验收记录

每次验收通过后，把结果记入对应任务的 `prd.md`：日期、走过的路径、耗时。
否则「上次验收是什么时候、结果如何」会无人知晓。
