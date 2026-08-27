# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 三平面结构、边界规则、生成物纪律、import 写法 | ✅ 已填（`08-22-repo-skeleton`） |
| [Database Guidelines](./database-guidelines.md) | 角色身份写入、SECURITY DEFINER、乐观版本号、错误映射、blob 阈值、测试隔离 | ✅ 已填（`08-23-persistence-artifact-store`） |
| [Error Handling](./error-handling.md) | `Result<T>`、`ErrorKind` 注册表、`retryable` 语义、防假绿 | ✅ 已填（`08-22-repo-skeleton`） |
| [Quality Guidelines](./quality-guidelines.md) | 质量门槛、测试分层、mock 纪律、验收凭据、禁用模式、review 清单 | ✅ 已填(2026-08-23 收尾;08-26 补验收凭据) |
| [Session Context](./session-context.md) | 上下文下行桥：`withPrompt` 只能追加、Adapter 渲染全部 section、`ContextBuilt` 不得说假话 | ✅ 已填（`08-26-v01-closeout`） |
| [Git Workspace](./git-workspace.md) | Agent 提交用 `-c` 钉死身份与签名、夹具关 gpgsign、`GIT_CONFIG_GLOBAL` 的使用边界 | ✅ 已填（`08-26-v01-closeout`） |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | ⏳ 暂缓 —— 尚无日志代码 |

> **⏳ 暂缓的 logging 是刻意留空的**,不是遗漏。
> 本项目的规则是「记录现实而非理想」:日志尚无任何代码,
> 现在写等于凭空发明约定,而子 agent 会照着它写出与实际不符的代码。
> 等 v0.1 有了真实实现再填。frontend 各文件同理(无前端代码)。

---

## 语言

代码注释与本 spec 用**中文**；标识符、类型名、字段名、命令用英文。

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
