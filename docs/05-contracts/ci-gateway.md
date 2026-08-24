# `CiGateway`（CI 外部事实源）

> CI 是 Keel 的**外部事实源**（`docs/09-roadmap.md` §3），系统本身不产生它。
> 本接口把「等待 / 读取 GitHub Checks + Commit Status」包装成 Control Plane
> 可依赖的薄边界。v0.1 的 GitHub 实现：`src/fact/github-provider.ts`。

---

## 0. 这份契约要解决的问题

Keel 在 `S-PR_OPEN` 停下来等 PR 上的 CI 结果。
但 CI 是**外部世界的事实**：系统无法在内部推导它，
只能读取并把它转成 `CIPassed` / `CIFailed` 事件驱动转移（T-024 / T-025）。

接口必须回答两个问题：
1. **等待多久、以什么粒度轮询** —— 硬超时怎么算「失败」;
2. **多个 CI 信号（Checks + Commit Status）怎么归并成三态** —— 谁说了算。

---

## 1. 接口

```ts
interface CiWaitInput {
  repoId: string
  remoteUrl: string        // https://github.com/owner/repo.git
  headSha: string          // PR head 的 commit SHA
  prNumber?: number        // 已知 PR 编号时传入,便于直接查 PR checks
}

interface CiGateway {
  waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>>
}
```

## 2. 归并语义（`combinedStatus`）

Checks 与 Commit Status **合并**成三态：

| 条件 | 结果 |
|---|---|
| 任一 check `completed` 且 conclusion 不是 `success` / `skipped` | `failed` |
| 任一 check 未 `completed` | `pending` |
| 无 checks;Commit Status `state != null` | 按 state:`success` → `passed`;否则 `failed` |
| Commit Status `state=pending` | 见下 |
| 无任何 check 也无任何 status | `passed`（没配 CI 的仓库不该永远卡死） |

### 2.1 `pending` 的特殊规则（实测修正,2026-08-24）

`state=pending` 且**无任何 status 上报** = **没人上报**（例如只有 GitHub
Actions 的仓库 —— Actions 走 check-runs，不写 commit status），
不是「还在跑」。此时直接判 `passed`。

**只有存在显式 status 时** `pending` 才按等待处理。
不这样处理，纯 Actions 仓库会永远卡在 pending、掉进硬超时。

---

## 3. 等待与超时

- 轮询间隔 / 上限可用 `pollIntervalMs` / `pollTimeoutMs` 覆盖（测试用毫秒级）;
- 默认：间隔 10s，上限 30min;
- **硬超时按 `failed` 处理** —— 由编排器转成 `CIFailed`（T-025），人可介入。
  这是刻意选择：CI 卡死不是「还在跑」，交给人工而不是无限等。

---

## 4. 错误语义

与 `git-provider.md` §3 相同（共享同一 HTTP 层）：
`AUTH_FAILED`（401/403）、`NOT_FOUND`（404）、`HARNESS_UNAVAILABLE`（429/5xx/网络层）。

---

## 5. 边界

- **只读取，绝不制造结论**：归并逻辑不猜测 CI 意图，只合并外部事实。
- **不创建 PR** —— 那是 `PullRequestGateway`（`git-provider.md`）。
- 实现 = `src/contracts/ci-gateway.ts`；单测用 stub HTTP server
  （`github-provider.test.ts`）；真实路径 = `test:acceptance`。