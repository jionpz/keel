# Implement — Harness Adapter

## Stage 1 · 解析器（纯函数，`omp-parse.ts`）
- [ ] 1.1 NDJSON 逐行解析，非 JSON 行忽略但记录
- [ ] 1.2 `session` 事件 → session_ref
- [ ] 1.3 `agent_end` → 文本（遍历全部 content block，按 type 分派）+ usage
- [ ] 1.4 单测：用真实抓到的事件流样本，含 thinking block

## Stage 2 · tier 推导（`tier.ts`）
- [ ] 2.1 `tierOf(caps)` 按 ADR-0005 修订后的定义
- [ ] 2.2 单测：改 capability 集合 → tier 随之变

## Stage 3 · `OmpAdapter`
- [ ] 3.1 argv 构造（PRD R1 的映射表）
- [ ] 3.2 spawn + 完整收集 stdout（P1）+ stdin 关闭
- [ ] 3.3 6 个方法
- [ ] 3.4 契约拒绝：untrusted 无能力 → CAPABILITY_UNSUPPORTED；native 无能力 → 同
- [ ] 3.5 幂等映射
- [ ] 3.6 argv 构造的单测（不起进程）

## Stage 4 · `HumanAdapter`
- [ ] 4.1 L0 能力集
- [ ] 4.2 可注入的 HumanInbox
- [ ] 4.3 单测

## Stage 5 · 真实集成测试 `[核心]`
- [ ] 5.1 startRun → awaitResult 跑通，断言 cost_usd / cost_basis / session_ref
- [ ] 5.2 真实 resume：记数字 → resume → 答对
- [ ] 5.3 collectChanges 读出真实 git 变更
- [ ] 5.4 标记为可选运行（环境无 omp 时明确失败而非静默跳过）

## Stage 6 · 隔离反例验证 `[核心]`
- [ ] 6.1 造一个留痕迹的 OMP 扩展
- [ ] 6.2 不加开关 → 有痕迹
- [ ] 6.3 加开关 → 无痕迹
- [ ] 6.4 若两次相同 → 如实记录「未能验证」，不假装通过

## Stage 7 · 收口
- [ ] 7.1 docs 同步（若有出入）
- [ ] 7.2 prd 验收
- [ ] 7.3 commit
