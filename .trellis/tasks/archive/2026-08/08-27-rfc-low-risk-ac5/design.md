# 技术设计（轻量）

## 根因

`src/control/orchestrator/prompts.ts` rfc_draft 末句：

> 若反馈不完整需要澄清,如实写 policy_facts 并按真实风险评估,**不要硬凑 low**。

验收 Issue 已写明 low/low，但模型仍抬高；提示词偏「宁高勿低」加剧失败。

## 方案

1. **提示词（主路径）**：分两档——
   - 反馈含显式 `risk=` / `complexity=` / `estimated_files` / `security` → `policy_facts` 必须拷贝这些值；
   - 反馈未给出 → 才自主评估；文档-only / 单文件默认倾向 low/low。
2. **可选加固**：Proposal 校验层对 rfc：若 Context 中 feedback 文本匹配 `risk=low` 而 `policy_facts.risk=='high'`，记 SCHEMA/业务 violation 回灌（一次），不改 Policy。
3. **验收**：仅跑 `issue-e2e`。

不改转移表、不改 ruleset。
