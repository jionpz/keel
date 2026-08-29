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
| `v01-criterion-github.acceptance.test.ts` | **合并验收**：编排器 + 真实 OMP + 真实 GitHub PR/CI 走完 S-NEW→S-DONE（含 fail-fast 权限探针、事件流完整重建断言） | `KEEL_GITHUB_TOKEN`、`KEEL_TEST_REMOTE_REPO` |
| `github-pr.acceptance.test.ts` | push → 真实建 PR → 幂等复用 → 真实 CI 回读（不经编排器） | 同上 |
| `session-milestone.acceptance.test.ts` | Session 里程碑路径 | 视用例而定 |
| `issue-e2e.acceptance.test.ts` | **真实 GitHub Issue** → S-DONE + 通过 CI 的真实 PR,事件流 T-001 起 T-024 终 | 上述两项 + 已登录的 `gh` CLI(创建/关闭验收用 Issue) |

早期的 `merge.acceptance.test.ts`（任务 `08-25-merge-acceptance`）与 `v01-criterion-github`
跑的是同一条昂贵链路，已删除，不再「保留作对照」：它的终态断言更宽松（容忍
S-HUMAN_REVIEW 等），夹具反馈对目标仓库并不成立（正是 `v01-criterion-github`
FEEDBACK 注释里分析过的那类夹具错误）；其唯一独特断言 ——「已有 PR 时
`createPullRequest` 幂等复用」—— 由 `github-pr.acceptance` 在工具层覆盖。

`issue-e2e` 与 `v01-criterion` 的差别只有一处,却正是 v0.1 判据里最后补上的那一环：
**「一条真实反馈进入系统」的「进入」**。前者事件流从 `T-001` 开始，后者从 `T-002`
开始（它的 S-NEW task 是 seed SQL 直插的）。

### 凭据

详细矩阵见 `.trellis/spec/backend/quality-guidelines.md` §验收测试的凭据。要点：

| 环境变量 | 用途 | 要求 |
|---|---|---|
| `omp` CLI（不是环境变量） | 六个阶段的推理 | 必须在 `PATH` 上 |
| `OPENCODE_API_KEY`（或 `DEEPSEEK_API_KEY`） | omp 推理网关 | 任一即可 |
| `KEEL_GITHUB_TOKEN`（或 `GITHUB_TOKEN`） | PR 创建 + CI 回读（REST API） | fine-grained PAT：Contents RW + Pull requests RW |
| `KEEL_TEST_REMOTE_REPO` | 真实远程仓库 | 对上述 token 可写 |

三个已实测的陷阱：

- **Cloud Agent 的 `ghs_` token 能 push 不能开 PR**（403）——
  `preflight.ts` 的探针会在起编排器之前失败并打印此信息；
- **`ghs_` 也不能给 Issue 打 label** —— `issue-e2e` 的 `gh()` 会把
  `KEEL_GITHUB_TOKEN` 注入 `GH_TOKEN`;只用 `gh auth login` 的 App token 时
  `gh issue create --label keel` 会静默建出无 label 的 Issue;
- **`omp` 不在环境里时，链路会假绿**（2026-08-28 实测）：缺它时每个 run 都失败，
  编排一路重试到 `T-031` 落进 `S-HUMAN_REVIEW` —— 与「Policy 判高风险」**同一个终态**。
  `issue-e2e` 早先只看终态就早退，于是什么都没跑出来也判绿。现已两处堵上：
  `preflightOmp()` 在第 0 秒挡掉，且 `T-031` 结尾一律判失败（不算 AC6 证据）；
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
