# `CiGateway`（CI 外部事实源）

> CI 是 Keel 的**外部事实源**（`docs/09-roadmap.md` §3），系统本身不产生它。
> 本接口把「等待 / 读取 GitHub Checks + Commit Status」包装成 Control Plane
> 可依赖的薄边界。v0.1 的 GitHub 实现：`src/fact/github-provider.ts`。
>
> **managed 路径不使用本接口的“无人上报即通过”兜底。** required checks 使用
> `RequiredCheckGateway`，见 §6。

---

## 0. 这份契约要解决的问题

Keel 在 `S-PR_OPEN` 停下来等 PR 上的 CI 结果。
但 CI 是**外部世界的事实**：系统无法在内部推导它，
只能读取并把它转成 `CIPassed` / `CIFailed` 事件驱动转移（T-042 / T-025）。

> `CIPassed` 只记录事实（T-042 自环），**不进入 S-DONE**。完成由 PR 合并
> （`PRMerged` → T-024）决定；PR 观测契约见 `git-provider.md` §4。

接口必须回答两个问题：
1. 如何区分可信的检查结论、尚未上报和暂时无法确定的观测。
2. 多个 CI 信号如何绑定到仓库、PR、提交和工作流轮次。

---

## 1. 接口

```ts
interface CiWaitInput {
  repoId: string
  remoteUrl: string        // https://github.com/owner/repo.git
  headSha: string          // PR head 的 commit SHA
  prNumber?: number        // 已知时用于绑定 PR 与 Actions 工作流
  allowUnreported?: boolean
}

interface CiGateway {
  waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>>
}
```

## 2. 观测与归并

两个网关按完整 SHA 分页读取 Checks 和 Commit Status。绑定 PR 时前后复读 PR，
只接受目标 PR 和 SHA 上的 Actions 工作流。Actions 检查通过 check suite、check ID、
job 的 run ID 和 `run_attempt` 与工作流绑定，最后复读工作流确认轮次未变化。
仅有同 SHA 的 push 检查，或远端无法提供足够的 PR / 轮次关联证据时，等待可信观测。
已知工作流仍在执行或尚未看到检查时，legacy 继续等待。required checks 按声明的检查名取证。

上报中的事实先归并为 `pending`。有可信终态且至少一项失败时归并为 `failed`，
其余已上报终态归并为 `passed`，legacy 接受 `success`、`skipped` 与 `neutral`。
Checks 和 Commit Status 都没有上报时返回 `unreported`。只有调用方显式允许
`allowUnreported` 且静默期已满时，legacy 才能据此通过。

---

## 3. 等待与超时

- 轮询间隔和上限可用 `pollIntervalMs` / `pollTimeoutMs` 覆盖，默认分别为 10 秒和 30 分钟。
- `CONFLICT` 与 `HARNESS_UNAVAILABLE` 有限退避重新观测。
- 达到截止时间返回 `RUN_TIMEOUT`，保留最后的观测错误供编排器诊断。
  仅可信检查失败产生 `CIFailed`。

---

## 4. 错误语义

与 `git-provider.md` §3 相同（共享同一 HTTP 层）：
`AUTH_FAILED`（401/403）、`NOT_FOUND`（404）、`HARNESS_UNAVAILABLE`（429/5xx/网络层）。

---

## 5. 边界

- **只读取，绝不制造结论**：归并逻辑不猜测 CI 意图，只合并外部事实。
- PR 读取用于验证 CI 绑定。创建由 `PullRequestGateway` 负责，交付状态观察由
  `PullRequestStateGateway` 负责（`git-provider.md` §6）。
- 受控重跑仅针对仍失败的首轮 Actions 运行，发出请求前复核绑定和运行轮次。
- 实现 = `src/contracts/ci-gateway.ts`；单测用 stub HTTP server
  （`github-provider.test.ts`）；真实路径 = `test:acceptance`。

## 6. managed `RequiredCheckGateway`

`src/contracts/required-checks.ts` 定义只读事实接口：

```ts
interface RequiredCheckObservationInput {
  repoId: string
  remoteUrl: string
  prNumber: number
  requiredChecks: string[]
  observedAt: string
}

interface RequiredCheckGateway {
  observeRequiredChecks(input: RequiredCheckObservationInput):
    Promise<Result<RequiredCheckSnapshot>>
}
```

实现先读取 PR 当前 head，再按该完整 SHA 读取 check-runs 与 commit statuses，
最后复读 PR head；期间变化则整次观察作废。required 名称没有上报时返回空事实，
控制层记录为 `missing` 并保持等待，到期失败；只有显式 `success` 才能完成。
这与 §2 的 legacy 四态归并刻意分离。
