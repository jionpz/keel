@AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `jionpz/keel`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `docs/02-glossary.md` + `docs/adr/`. See `docs/agents/domain.md`.

## 工作流

- 入口：`/flow:route`。它按任务大小确定阶段路径，由阶段表选择提供者。
- 需求不清：`/spec:grill-with-docs`；拆票：`/spec:to-tickets`；需要地图：`/spec:wayfinder`。
- 实现提供者由 route 的阶段表选择：单任务用 `flow:execute`，多独立 ticket 或跨日编排用 `pstack:poteto-mode`。
- 所有 harness（含 Codex / DSH）统一使用 jstack，安装与降级入口见 `AGENTS.md`。Trellis 已退役。
- 项目规范读 `docs/spec/`。
- managed 产品状态与边界读 `docs/managed-state-machine.md`；旧 `S-*` Task/Run 契约只适用于 `legacy-v01`。
