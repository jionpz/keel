# Phase 0：OMP 实时 flush spike 结论

日期：2026-11-05
脚本：`.trellis/tasks/11-04-run-liveness-patrol/research/omp-flush-spike.mjs`

## 结论

**OMP 在 `-p --mode=json` 下确实在运行期间逐行输出 NDJSON，不是退出时一次性 flush。**

本次运行的关键时间点（相对进程启动）：

| 事件 | 到达时间 |
|---|---|
| `session` | 538 ms |
| `agent_start` | 635 ms |
| `turn_start`（第 1 轮） | 662 ms |
| `toolcall_start` / `toolcall_delta` | 2964–3255 ms |
| `tool_execution_start`（`sleep 4`） | 3503 ms |
| `tool_execution_update` / `tool_execution_end` | 7562 ms |
| `turn_end`（第 1 轮） | 7587 ms |
| `turn_start`（第 2 轮） | 7590 ms |
| `text_start` / `text_delta` / `text_end` | 9585–9691 ms |
| `agent_end` | 9704 ms |

- 进程总时长 9744 ms，`turn_start` 比退出早 9082 ms。
- 输出跨度 9166 ms，说明事件是分散到达的。
- 最大间隔 4059 ms，正好覆盖工具执行的 `sleep 4`；这是合法静默，不是卡死。

## 对设计的影响

1. **实时 flush 成立**，可以继续按增量解析 + 进展信号实现，不需要换进展源。
2. **进展事件不止 6 种**。实际流里还有：
   - `tool_execution_start`
   - `tool_execution_update`
   - `tool_execution_end`
   - `message_update` 的嵌套事件：`thinking_start` / `thinking_delta` / `thinking_end`、
     `toolcall_start` / `toolcall_delta` / `toolcall_end`、
     `text_start` / `text_delta` / `text_end`
   
   `ProgressKind` 至少要把 `tool_execution_*` 纳入；`message_update` 按顶层类型计数即可，
   不必为每个嵌套类型建 union。
3. **`advisor_cost_changed` 不算进展**（纯成本通知）；其余 JSON 事件都可以作为进展。
4. 工具执行期间的静默可达数秒到数分钟（编译、测试、下载）；`develop` 的 20 分钟 silence
   阈值远高于本次观测到的 4 秒，但仍需在真实长任务上校准。

## 环境说明

- 使用 `magpie/workbuddy-ai/hy3`，因为：
  - `deepseek-v4-flash` 经 `zen` 返回 `400 MissingSessionID`；
  - `magpie/auto/deepseek-v4.1-flash:high` 返回 429 配额耗尽。
- 这是环境选择，不是 Keel 的默认模型；本任务不改 `DEFAULT_OMP_MODEL`。
- stdin 必须关闭（`stdio: ['ignore','pipe','pipe']`），否则 OMP 卡在 `readPipedInput`。

## 复现

```bash
node .trellis/tasks/11-04-run-liveness-patrol/research/omp-flush-spike.mjs
```

脚本只读，不写 Keel 数据库；临时目录由 `mkdtemp` 创建。
