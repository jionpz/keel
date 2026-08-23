# Implement — 工作区隔离与 git 集成

## Stage 1 · `GitWorkspace`
- [ ] 1.1 `ensureBareRepo(repo)` —— 从 remote_url 克隆/初始化裸仓库
- [ ] 1.2 `ensureWorktree(taskId, baseBranch)` —— 幂等创建 worktree + 分支
- [ ] 1.3 `commitAll(taskId, message)` —— 真实提交
- [ ] 1.4 `remove(taskId)` / `preserve(taskId)`
- [ ] 1.5 测试：隔离性、幂等性、提交可见性

## Stage 2 · 接上副作用执行器
- [ ] 2.1 `CreateBranch` → 真实 ensureWorktree
- [ ] 2.2 `CleanWorkspace` → 真实 remove
- [ ] 2.3 `PreserveWorkspace` → 标记保留
- [ ] 2.4 `CreatePullRequest` **保持 SideEffectIntent**

## Stage 3 · 编排器改用 worktree
- [ ] 3.1 每个 run 在该 Task 的 worktree 里跑
- [ ] 3.2 develop 后提交

## Stage 4 · 收口
- [ ] 4.1 docs 同步
- [ ] 4.2 prd 验收
- [ ] 4.3 commit
