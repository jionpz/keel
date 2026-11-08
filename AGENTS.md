# Keel 工程规则

## 工作流路由

- **所有 harness**：使用 jstack 工作流。入口是 `/flow:route`，它按任务大小在 `spec` 和 `pstack` 之间路由：需求澄清与拆票用 `/spec:*`，实现用 `/pstack:poteto-mode`。
- **Claude Code / OMP**：直接使用已安装的 jstack 插件。
- **Codex / DSH**：jstack 暂无这两个 harness 的插件适配，按本文件工作；需要完整流程时，读取 jstack 仓库（`jionpz/jstack`）的 `plugins/flow/skills/route/SKILL.md` 并照做。
- Trellis 已在本仓库退役：不再有 `.trellis/`、`.agents/skills/`、`.dsh/` 或 Trellis hooks，不要运行 `trellis update`。

## 项目规范（所有 harness）

- 写代码前先读 `docs/spec/backend/index.md` 或 `docs/spec/frontend/index.md` 指向的相关规范；这是项目的编码约定。
- 架构事实来源是 `docs/`：先读 `docs/01-overview.md`、`docs/02-glossary.md`、`docs/03-domain-model.md`，改架构前读 `docs/adr/`。
- 提交前必须 `pnpm run check`；CI 跑同一条。
- 遵守 C1–C4：`docs/schemas/` 是生成源；Execution Plane 不写 Fact Plane；转移函数必须是纯函数；转移表必须与 `docs/04-state-machine.md` 同步。
- 代码注释与文档用中文；标识符、类型名、命令用英文。

## 任务与 issue

- 所有 harness：用 GitHub Issues（`jionpz/keel`）。约定见 `docs/agents/issue-tracker.md`。
- 历史任务与 journal 在 `docs/archive/`，只作为证据保留，不再新建。
