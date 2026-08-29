# Claude Code CLI 接口调研（待实测）

> 任务：`.trellis/tasks/08-29-second-harness`
> 状态：**待填** —— start 后本机实测，格式照抄 `08-23-harness-adapters/research/omp-interface.md`

## 待验证项

| 能力 | 预期 | 实测命令 | 结果 |
|---|---|---|---|
| CAP-HEADLESS | `-p` 或等效 | | |
| CAP-STREAM | NDJSON / 事件流 | | |
| CAP-RESUME | session id 恢复 | | |
| CAP-COST | usage / cost 字段 | | |
| CAP-UNTRUSTED_WORKSPACE | `--bare` | | |
| 退出码 | 0 成功 / 非 0 失败 | | |

## 参考

- `docs/adr/0005-harness-support-tiers.md`
- `.trellis/tasks/archive/2026-08/08-22-keel-architecture-framework/research/harness-interfaces.md`
