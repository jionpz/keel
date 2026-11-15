# Keel 工程规则

## 工作流路由

- **所有 harness**：使用 jstack 工作流。入口是 `/flow:route`；澄清与拆票交给 `spec`，单任务实现交给 `flow:execute`，多独立 ticket 或跨日编排交给 `pstack:poteto-mode`，由阶段表决定提供者。
- **Claude Code / OMP**：直接使用已安装的 jstack 插件。
- **Codex**：jstack 已支持项目级入口、agents 与 hooks；入口可由 `.agents/skills/route` 指向 `.jstack/vendor/`。有安装时先核对 `.jstack/lock.json` 与 `jstack doctor`，不要把目录存在当成门禁已加载的证据。
- **DSH 或缺少安装的 harness**：读取 jstack 仓库（`jionpz/jstack`）的 `plugins/flow/skills/route/SKILL.md` 及其 `locate.sh` 定位的提供者，按同一流程工作。
- 工程流程以核实过的 jstack 版本为准，不能把旧 checkout 或缓存称为“最新”；版本和实际验证写入交付证据。产品运行中的 managed 任务始终使用绑定的固定包，升级工程流程不改写它们。
- Trellis 已在本仓库退役，不运行 `trellis update`；`.agents/skills/`、`.omp/` 等可能是当前 jstack 安装产物，不能仅按目录名判定为 Trellis 残留。

## 项目规范（所有 harness）

- 写代码前先读 `docs/spec/backend/index.md` 或 `docs/spec/frontend/index.md` 指向的相关规范；这是项目的编码约定。
- 架构事实来源是 `docs/`：先读 `docs/01-overview.md`、`docs/02-glossary.md`、`docs/03-domain-model.md`，改架构前读 `docs/adr/`。
- 当前产品状态机读 `docs/managed-state-machine.md`；`docs/04-state-machine.md` 是 `legacy-v01` 契约。两套状态和完成条件不能混用，历史流程不作为新 managed 功能的设计源。
- 提交前必须 `pnpm run check`；CI 跑同一条。
- 遵守 C1–C4：`docs/schemas/` 是生成源；Execution Plane 不写 Fact Plane；转移函数必须是纯函数；转移表必须与 `docs/04-state-machine.md` 同步。
- 代码注释与文档用中文；标识符、类型名、命令用英文。

## 任务与 issue

- 所有 harness：用 GitHub Issues（`jionpz/keel`）。约定见 `docs/agents/issue-tracker.md`。
- 历史任务与 journal 在 `docs/archive/`，只作为证据保留，不再新建。
