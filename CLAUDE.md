@AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `jionpz/keel`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `docs/02-glossary.md` + `docs/adr/`. See `docs/agents/domain.md`.

## 工作流

- 入口：`/flow:route`。它按任务大小在 `spec` 和 `pstack` 之间路由。
- 需求不清：`/spec:grill-with-docs`；拆票：`/spec:to-tickets`；需要地图：`/spec:wayfinder`。
- 实现：`/pstack:poteto-mode`。
- 所有 harness（含 Codex / DSH）统一使用 jstack；Codex / DSH 的入口说明见 `AGENTS.md`。Trellis 已退役。
- 项目规范读 `docs/spec/`。
