# Design — Harness Adapter

## 1. 文件布局

```
src/execution/adapters/
├── omp.ts            # OmpAdapter（L2）
├── omp-parse.ts      # NDJSON 事件流解析（纯函数，可单测）
├── human.ts          # HumanAdapter（L0）
├── tier.ts           # 由 capability 集合推导 tier
└── *.test.ts
```

**解析器单独成文件**是刻意的：它是纯函数（字符串 → RunResult），
可以用固定的事件流样本单测，不需要真的起进程。
真实集成测试只用来验证 argv 与进程交互 —— 两者分开，各测各的。

## 2. tier 由 capability 推导，不硬编码

`ADR-0005` 修订后阶梯不参与决策，但仍作为人看的摘要输出。

```ts
tierOf(caps) =
  has(STREAM) && has(COST) && has(RESUME) ? 'L2'
  : has(RESUME)                            ? 'L1'
  : 'L0'
```

改 capability 集合，tier 自动跟着变 —— 测试会锁住这一点。

## 3. 进程交互的两条硬约束（来自实测）

### P1：必须读完整个 stdout

提前关闭管道 → omp 收到 SIGPIPE → **会话文件写不出来** → resume 失效。

实现：用 `spawn` 收集全部 stdout 到内存，进程 `close` 后再解析。
**不使用流式提前返回**（v0.1 不实现 `observe()`，正好避开这个坑）。

### P2：content block 类型多样

实测 deepseek 返回 `[{type:'thinking'}, {type:'text'}]`。
解析器遍历全部 block，只取 `type === 'text'` 的拼接，其余忽略但计数。

## 4. `CAP-UNTRUSTED_WORKSPACE` 的验证方法

上一轮只确认开关存在。本任务要验证它**有效**：

1. 建临时 git 仓库
2. 放一个 OMP 扩展，其副作用是往某个文件写一行痕迹
3. 跑两次：不加隔离开关 / 加隔离开关
4. 断言：第一次有痕迹、第二次没有

**若两次结果相同**（都无痕迹 / 都有痕迹），说明这个测试没有真正探到隔离机制 ——
此时**不得**假装验证通过，而应如实记录并把该能力标为「未能验证」。

> 这是本项目一贯的纪律：反例不成立时改结论，不改测试。

## 5. 成本口径

`usage.cost.total` 存在，但**文档未说明是 billed 还是 estimated**。
按 `estimated` 上报 —— 与 Claude Code 一致。
`docs/08-cross-cutting.md` §3.1 已规定：只有 `billed` 才可用于对外计费。

## 6. 幂等

`startRun` 内维护 `idempotency_key → RunHandle` 的进程内映射。
v0.1 单进程，够用；多进程时改为查 `run` 表（`UNIQUE(idempotency_key)` 已在）。
这一点在代码注释中写明局限。

## 7. 风险

| 风险 | 对策 |
|---|---|
| 真实调用慢 / 不稳定 | 集成测试用最短 prompt；解析逻辑由样本单测覆盖，不依赖真实调用 |
| 隔离反例测不出差别 | 见 §4 —— 如实记录为「未能验证」，不假装通过 |
| deepseek 的 thinking block 让输出形状变化 | 解析器按 type 分派，不假设顺序或数量 |
