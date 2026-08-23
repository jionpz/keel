# Implement — Session Manager

## Stage 1 · `extract.ts`（纯函数）
- [ ] 1.1 三级提取策略
- [ ] 1.2 平衡括号扫描，不用正则暴力匹配
- [ ] 1.3 测试：围栏 / 裸 JSON / 带前后文 / 嵌套 / 提取失败

## Stage 2 · `validate.ts`
- [ ] 2.1 ajv 编译 `src/generated/schemas.ts` 的全部 schema
- [ ] 2.2 五步流水线
- [ ] 2.3 平面越界黑名单（递归查键名）
- [ ] 2.4 测试：每步各有一个会被它拒的反例

## Stage 3 · `manager.ts`
- [ ] 3.1 selectAdapter / open / advance / checkpoint / close
- [ ] 3.2 R-007 回灌循环
- [ ] 3.3 提示词：要求模型产出 A-StageOutcome JSON

## Stage 4 · 里程碑测试
- [ ] 4.1 真实 OMP session → 提案 → 校验 → 落库
- [ ] 4.2 driver 读 verdict 推进状态
- [ ] 4.3 断言测试代码未提交任何产物

## Stage 5 · 收口
- [ ] 5.1 docs 同步
- [ ] 5.2 prd 验收
- [ ] 5.3 commit
