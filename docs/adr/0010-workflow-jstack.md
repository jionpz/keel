# ADR-0010 · 开发工作流全员迁移到 jstack，Trellis 退役

**Status**: **Accepted** — 2026-11-07 用户拍板
**Date**: 2026-11-07
**Related**: ADR-0003（Workflow engine 选型，与产品运行时无关）；`#76`–`#80`；`project/keel/decisions/jstack-migration-2026-11-07`

## Context

首轮迁移只把 Claude Code / OMP 切到 jstack，保留 Trellis 给 Codex / DSH，
理由是 jstack 当时只适配 Claude Code / Pi / OMP / Cursor。保留 Trellis 的代价是：

- 两套主编排并存：`.trellis/workflow.md` 的 hooks 与 jstack 的 `/flow:route` 各自定义「下一步做什么」；
- `.trellis/` 同时装项目规范（`.trellis/spec/`）、任务、journal、脚本和运行时，
  规范被绑死在一个可被 `trellis update` 整体重写的目录里；
- `trellis update` 会重写 `AGENTS.md` / `CLAUDE.md` 与模板文件，
  每次升级都要人工核对 jstack 路由没有被改回；
- Codex / DSH 与主力 harness 的流程分叉：同一仓库里，任务记录和实现流程因 harness 而异。

用户要求**完全**切换，不再保留 Trellis 作为任何 harness 的工作流。

## Options

| 选项 | 机制 | 评价 |
|---|---|---|
| **A. 保留 Trellis 给 Codex / DSH** | 维持现状 | 双编排继续存在；规范与运行时仍耦合在 `.trellis/`；每次 Trellis 升级都要防回退 |
| **B. 全员切到 jstack；Codex / DSH 只按 `AGENTS.md` 工作** | 删除 Trellis 及全部接线 | 单一编排；规范与工具解耦；代价是 Codex / DSH 失去 hooks、task system 与自动技能发现 |
| C. 全员切到 jstack，另留薄指针 skill 给 DSH | 删除 Trellis，`.agents/skills/` 留指针 | 保留 DSH 技能发现；多一份会漂移的入口，且仍要维护 `.agents/` |

## Decision

**B。**

### 1. 删除范围

- `.trellis/`（workflow、spec、tasks、workspace、runtime、scripts、agents、legacy）
- `.agents/`（Trellis 技能）、`.dsh/`（DSH 技能与入口）、`.omp/`（OMP Trellis 扩展）
- `.codex/hooks.json`、`.codex/hooks/*.py`、`.codex/agents/trellis-*.toml`
- `scripts/check-workflow-overrides.ts` 与 `package.json` 的 `check:workflow`
- `.gitattributes` 中为 Trellis 模板加的规则

保留 `.codex/config.toml`（只是 shell 环境策略，与 Trellis 无关）。

### 2. 规范与历史迁移

- `.trellis/spec/` → `docs/spec/`，保留 `backend/` / `frontend/` / `guides/` 结构；
  `guides/workflow-overrides.md` 是 Trellis 专属，删除。
- `.trellis/tasks/archive/<year>/<id>` → `docs/archive/tasks/<year>/<id>`；
  `.trellis/workspace` → `docs/archive/journals/`。
- 所有源码、文档、迁移脚本中的路径引用同步改写；
  顺带修好迁移前就已损坏的 `archive/<year>` 缺段引用。

### 3. 工作流入口

- 所有 harness 的唯一工作流入口是 jstack：`/flow:route` → `/spec:*` / `/pstack:poteto-mode`。
- Claude Code / OMP 直接使用插件；Codex / DSH 没有插件适配，按 `AGENTS.md` 工作，
  需要完整流程时手动读取 jstack 仓库的 `plugins/flow/skills/route/SKILL.md`。
- 任务与 issue 统一用 GitHub Issues（`jionpz/keel`），不再有第二套 task system。

## Consequences

### 正面

- 单一主编排，`AGENTS.md` 不再需要声明「哪个 harness 走哪套流程」；
- 项目规范脱离 `trellis update` 的重写范围，成为普通文档；
- 依赖减少：不再需要 Trellis CLI / runtime / hooks；
- 历史证据保留在 `docs/archive/`，链接仍可点开；
- Codex / DSH 与主力 harness 共用同一份规则和同一个 issue 面板。

### 代价与边界

1. **Codex / DSH 失去 Trellis 的 hooks、task system 与自动技能发现**；
   它们只按 `AGENTS.md` 工作，完整流程需要手动读 jstack 入口。
2. **jstack 没有 Codex / DSH 插件适配**；要恢复原生支持，需要在 jstack 仓库补适配，
   不在本仓库内解决。
3. **归档任务是历史证据**：`docs/archive/` 内的内容按原样保留，
   不再作为活跃任务跟踪，也不再产生新的归档。
4. **两份 imported thinking guide 仍含上游 Trellis 模板示例**
   （`docs/spec/guides/code-reuse-thinking-guide.md`、
   `cross-layer-thinking-guide.md`）。按迁移决策保持内容不变，
   它们不是当前工作流说明。
5. **回滚依赖 git 历史**：`.trellis/legacy/` 已删除，恢复旧工作流需要从迁移前的提交取回。

## 实现锚点

- `AGENTS.md` — 全员 jstack 路由与 Codex / DSH 入口
- `CLAUDE.md` — Claude Code 入口与项目规范指针
- `README.md` — 「AI 工作流」段落
- `docs/spec/` — 从 `.trellis/spec/` 迁入的项目规范
- `docs/archive/tasks/`、`docs/archive/journals/` — 历史任务与 journal
- `package.json` — 移除 `check:workflow`
- `.claude/settings.json` — 启用 `pstack@jstack` / `spec@jstack` / `flow@jstack`

## 验证

- `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions / purity / test）；
- `git ls-files` 中不存在 `.trellis/`、`.agents/`、`.dsh/`、`.omp/` 与 Trellis hooks；
- `rg -i trellis` 只命中允许的历史 / 对比 / 归档内容（见代价第 3、4 条与 ADR-0002）；
- 所有改写后的 `docs/spec/` 与 `docs/archive/` 路径在磁盘上存在；
- 迁移记录见 `#76`–`#80`。
