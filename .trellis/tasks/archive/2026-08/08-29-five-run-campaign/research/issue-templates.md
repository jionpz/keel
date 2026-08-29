# 五连 Issue 模板（5 变体）

均为文档-only、low/low/1、禁止改代码。约束键名与 `feedback-constraints` / rfc_draft 提示词同源。

## 变体 1 — README 导出说明

```
目标:只改 README.md 一处文档,补一句「导出支持按日期筛选」。
约束(必须遵守,写进 RFC.policy_facts):
- risk=low
- complexity=low
- estimated_files=1
- security_sensitive=false
- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件
这是验收探针 run-1,不是架构变更。
```

## 变体 2 — README 安装说明

```
目标:只改 README.md 开发节,补一句「需 Node 24+」。
约束(必须遵守,写进 RFC.policy_facts):
- risk=low
- complexity=low
- estimated_files=1
- security_sensitive=false
- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件
这是验收探针 run-2,不是架构变更。
```

## 变体 3 — README 验收命令

```
目标:只改 README.md,在开发节补一行 test:acceptance 示例。
约束(必须遵守,写进 RFC.policy_facts):
- risk=low
- complexity=low
- estimated_files=1
- security_sensitive=false
- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件
这是验收探针 run-3,不是架构变更。
```

## 变体 4 — README 术语表

```
目标:只改 README.md,在术语表补「Keel = 编排运行时」一句。
约束(必须遵守,写进 RFC.policy_facts):
- risk=low
- complexity=low
- estimated_files=1
- security_sensitive=false
- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件
这是验收探针 run-4,不是架构变更。
```

## 变体 5 — README 状态节

```
目标:只改 README.md 状态节,补一句「v0.1 进入环节已闭合」。
约束(必须遵守,写进 RFC.policy_facts):
- risk=low
- complexity=low
- estimated_files=1
- security_sensitive=false
- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件
这是验收探针 run-5,不是架构变更。
```
