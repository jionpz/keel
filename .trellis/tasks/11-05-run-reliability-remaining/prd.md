# 运行可靠性剩余项

> 对应 GitHub issue [#73](https://github.com/jionpz/keel/issues/73)。
> 本文只写范围与跨子验收；技术细节在各子任务。

## Goal

收口 #73 的三项可靠性缺口：失败 run 的现场可追查、常驻进程单实例、GitHub token 来源明确。

## 任务地图

| 子任务 | issue 条目 | 依赖 | 体量 |
|---|---|---|---|
| `11-05-fail-run-harness-id` | 第 1 项 | 无 | 小 |
| `11-05-github-token-source` | 第 3 项 | 无 | 小 |
| `11-05-poller-single-instance` | 第 2 项 | 无 | 中（需 design.md） |

三项彼此独立，可任意顺序；建议先做前两个小项，再处理单实例锁。

## Cross-child Acceptance

- [ ] 三项合入后，issue #73 可关闭。
- [ ] `pnpm run check` 全绿。
- [ ] 不新增外部服务、不引入新依赖。
- [ ] 不改变现有默认行为：未配置新变量时与当前一致。

## Out of Scope

- 模型可用性探测（属 #70 §4 的部署验收）。
- 多实例并发调度 / 分池 / 故障转移。
- 其他代码托管平台的 token 来源。
- 旧 run 的 `harness_id` / `requested_model` 回填。
