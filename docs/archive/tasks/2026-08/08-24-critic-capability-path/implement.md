# Critic 能力路径接线 — 执行计划

## 批次与顺序

### 批次 1 — G4 规则 + G3 提示词(独立小改,先行)

1. `ruleset.ts`:DEFAULT_RULES 加 `P-ALLOW-CRITIC`(points=['capability_request'], condition `facts.capability == 'critic_review'`, action auto_develop, priority 100)。
2. `prompts.ts`:
   - `expectedArtifact('critic')` → `{kind:'critic_review', key:''}`(当下 `stage_outcome`);
   - `promptFor('critic')` → 输出 critic_review 形状示例(占位不写死),参照 docs/06-artifacts.md §5。
3. 回归:
   - `policy.test.ts`:`P-ALLOW-CRITIC` validate() 过;evaluate capability_request+critic_review → auto_develop;human_input → human_review。
   - `prompts.test.ts`:promptFor('critic') 含 critic_review 字段;expectedArtifact('critic').kind==='critic_review'。
4. `pnpm run check`。

### 批次 2 — G2 转移修正(含文档)

1. `table.ts`:
   - T-010 guard:`(_f,e) => e.type==='RunSucceeded' && e.stage==='brainstorm'`,guardText `stage=brainstorm`;
   - 新增 T-009b:S-BRAINSTORM + RunSucceeded{critic} → SELF,effects `[nextRun('brainstorm')]`。
2. `docs/04-state-machine.md` §2:T-010 行 guard 更新;加 T-009b 行。
3. 回归:
   - `transition.test.ts`:T-010 只匹配 stage='brainstorm';stage='critic' → T-009b;
   - `check:transitions`(C4 含 guardText)。
4. `pnpm run check`。

### 批次 3 — G1 编排触发与回流(e2e 核心)

1. `loop.ts`:
   - 新增 `readPendingCapabilityRequest(taskId)`(最新 capability_request artifact 的 body.capability,无 → null);
   - 新增 `hasCapabilityRequestedEvent(taskId)`(`event.type='CapabilityRequested'` 存在?);
   - 阶段态处理后、pending==null 时:`S-BRAINSTORM` + req!=null + 无 CapabilityRequested 事件 → advance `{type:'CapabilityRequested', capability: req}`;advanced=false(deny)→ ok 返回(停,人介入);advanced=true → continue。
   - critic run 完成路径无需特判:T-009b 自动接住(批次 2)。
2. 回归 e2e `src/e2e/critic-capability-path.test.ts`:
   - fake adapter:brainstorm 产 A-State(候选方案)+ A-CapabilityRequest;critic 产 A-CriticReview;brainstorm(2) 产 StageOutcome(converged);
   - 断言:run(critic) 创建、critic_review 落库、brainstorm(2) 的 context 含评审、终态 S-RFC_DRAFT、事件流可重建。
3. `pnpm run check`。

### 批次 4 — 文档收尾 + 全量验证

1. `docs/07-flows.md` 步骤 8-14 与实现核对(若实现路径与 flow 表述有差异,以代码为准更新 flow 的「实现注记」,不改 flow 理想态)。
2. `pnpm run check` 全绿;`test:acceptance` 保留凭据门控(本轮不跑真实 OMP)。
3. Commit footer:`(issue #21 #1-15)`(Round 1 后续项)或按 trellis 惯例标注本任务。

## 验证命令

```bash
pnpm run check
# lint → typecheck → boundaries → check:generated → check:transitions → check:purity → test
```

## 评审门

- 批次 3 前:确认「回流 = brainstorm(n+1)」与 flow 步骤 12 的 rematerialize 语义一致(不实现 resume)。
- T-009b 的编号(文档转移表)与 guardText 需过 C4 比对。
- MAX_STAGE_ATTEMPTS=3 是否够 brainstorm(1)+critic 失败重试:brainstorm 最多 3 次,加 critic 回流后仍 ≤3?若 critic 失败走 T-030(brainstorm 计数不变,是 critic 计数)——确认 attempt 按 stage 独立计。

## 回滚

- 每批独立 commit;回滚 = revert 单 PR。
- G4 规则删除即可回到「缺裁决即拒」(Round 1 状态),不破坏其他。

## 验收核对

| R | 交付 | 验证 |
|---|---|---|
| R1 放行规则 | ruleset.ts P-ALLOW-CRITIC | policy.test 2 例 |
| R2 编排触发 | loop.ts 触发 + 幂等防重 | e2e 断言 |
| R3 转移修正 | T-010 guard + T-009b + 文档 | transition.test + C4 |
| R4 提示词 | prompts.ts critic_review 形状 | prompts.test |
| R5 端到端 | e2e 全链路 | 事件流重建断言 |