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
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | ⏳ 暂缓 —— 尚无数据库代码 |
| [Error Handling](./error-handling.md) | `Result<T>`、`ErrorKind` 注册表、`retryable` 语义、防假绿 | ✅ 已填（`08-22-repo-skeleton`） |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | ⏳ 暂缓 |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | ⏳ 暂缓 —— 尚无日志代码 |

> **⏳ 暂缓的三项是刻意留空的**，不是遗漏。
> 本项目的规则是「记录现实而非理想」：数据库与日志尚无任何代码，
> 现在写等于凭空发明约定，而子 agent 会照着它写出与实际不符的代码。
> 等 v0.1 有了真实实现再填。

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
