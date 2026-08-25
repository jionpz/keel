# Round 2 P2 行为正确性组 — 执行计划

## 批次

### 批次 1 — R8(git-diff 分类)+ R9(FAILED 文档),独立小改

1. `git-diff.ts`:分类逻辑按工作区列(Y 列为主,未跟踪 added)。
2. `git-diff.test.ts`:补 `AD`/`MM`/`??` 用例。
3. `manager.ts` RUN_STATUS_ERROR 注释;`harness-adapter.ts` RunResult.status 注释。
4. `pnpm run check`;commit footer `(issue #23 R8 R9)`。

### 批次 2 — R7(interrupt SIGKILL + 进程组)

1. `omp.ts` run() spawn 加 `detached:true`;interrupt 加 SIGTERM→(2s)→SIGKILL 兜底(timer.unref)。
2. 超时可注入(`OmpOptions.interruptKillTimeoutMs?`,测试用短值)。
3. `adapters.test.ts`:interrupt fixture 断言 SIGTERM + 兜底 SIGKILL(fake timers / 注入短超时)。
4. `pnpm run check`;commit footer `(issue #23 R7)`。

### 批次 3 — R5 + R3 + R4(critc 上限 / capability 来源 / guard 拒=停),联动

1. `loop.ts`:
   - `brainstormNeedsCritic` 加 critic run 计数上限(≥2 强制收敛);
   - 新增 `brainstormRequestedCapability`(读 details.capability,缺省 'critic_review');
   - synthesize 与事件用该 capability(不再硬编码);
   - CapabilityRequested advance 后查 advanced:false → 停(return ok 当前状态)。
2. `prompts.ts` brainstorm 提示词加 capability 字段说明。
3. 适配 `critic-path.test.ts`(现有 e2e:capability 来自 details.capability;R5 上限不破坏正常路径——1 次请求 <2)。
4. 新增 e2e `critic-livelock.test.ts`(或并入 critic-path):连续 needs_critic → 第 3 次强制收敛走 T-010;capability='other' → 拒 → 停。
5. `pnpm run check`;commit footer `(issue #23 R3 R4 R5)`。

### 批次 4 — 全量验证 + 收尾

1. `pnpm run check` 全绿。
2. issue #23 追加 comment(P2 行为组 6 项已修;架构组另开)。
3. 归档任务;journal + gbrain 更新。

## 验证命令

```bash
pnpm run check
```

## 评审门

- R7 的 detached:true 是否影响现有真实集成(omp spawn)?——测试用 fake spawn,真实路径行为不变(spawn 选项扩展)。
- R3 的 capability 缺省 'critic_review' 是否破坏向后兼容?——提示词已加字段,旧模型无 capability 字段时走缺省,兼容。
- R5 上限 2 是否过严?——语义:最多 2 轮评审;第 2 回流后必进 RFC。与 flow 一致(critic 评审是辅助,不是无限迭代)。

## 回滚

- 每批独立 commit;回滚 = revert 单 commit。
- R5 上限若误杀正常路径:调大阈值(critic 计数调整)或按 stage_attempts 判断。