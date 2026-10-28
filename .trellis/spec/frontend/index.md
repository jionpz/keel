# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## 状态:部分填充

本项目的主体仍是纯后端(TypeScript / Node)。2026-10-27 起多了第一份真实前端代码:
`src/cli/console.ts` + `src/cli/console-page.ts`(只读 Web 控制台)。

因此**只**填写与它相关的约定;其余文件继续保持留空 ——
「记录现实而非理想」的规则不变,没有对应代码的地方不凭空发明。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Console Guidelines](./console-guidelines.md) | 只读控制台:单文件零构建、GET-only、数据口径与 CLI 一致、404/503 纪律 | ✅ 已填（`10-27-console-and-demo-app`） |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
