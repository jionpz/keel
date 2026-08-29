# OMP 模型可配 · 执行清单

1. [x] `resolveModel(cli, env)` 纯函数 + 单测
2. [x] `RunTaskOptions.model` → `new OmpAdapter({ model })`
3. [x] `run-task` / `run-issue` argv `--model`；help 文案
4. [x] `run-issue` options 透传
5. [x] README / acceptance README 一行
6. [x] `pnpm run check`

不跑五连（缺省未变）。可选：人工 `KEEL_MODEL=…` 单次 issue-e2e，不作为 AC。
