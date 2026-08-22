# ADR-0001 · 采用 ADR 记录架构决策

**Status**: Accepted
**Date**: 2026-08-22

## Context

初稿 `AI_Engineering_Runtime_Architecture.md` 的选型章节全是"推荐 A / B / C"，
没有一处写明**选了哪个、为什么、代价是什么**。

后果是：六个月后没人能回答"当初为什么不用 Temporal"，
于是这个问题会被反复重新讨论，每次都从零开始。

## Decision

每个不可轻易推翻的选型写一份 ADR，编号递增，**永不删除**。

推翻旧决策的方式是写新 ADR 并把旧的标为 `Superseded by NNNN`，而不是修改旧文件。

## Consequences

- ✅ "当初为什么这么定"有确定答案
- ✅ 被推翻的决策连同其理由一并保留 —— 这比结论本身更有价值
- ⚠️ 需要纪律：选型时顺手写，事后补写的 ADR 会不自觉地美化当时的判断
