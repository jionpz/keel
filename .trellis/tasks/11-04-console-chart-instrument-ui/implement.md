# 海图仪表 — 实施计划

## 顺序

1. **Token 换血**
   - [x] `:root` / 暗色两套全部改成 paper / ink / signal / move / good / bad / special
   - [x] 全局按「长名优先」替换旧 token 名（`--line-strong` 先于 `--line`，`--bg-elev` 先于 `--bg`）
   - [x] 清掉硬编码的 `rgba(128,128,128,…)` 悬浮底，改用 `--hover`

2. **字体与层级**
   - [x] `--sans` 换成 Avenir Next / PingFang SC
   - [x] 正文 13px→12.5，元信息 11，页标题 19/600
   - [x] 等宽只保留给 ID / 分支 / 命令 / JSON / diff / 事件码

3. **状态与按钮**
   - [x] `.badge` 去胶囊、去底色：7px 方块 + 中文 + 机器码
   - [x] `.mode-pill` 同构化
   - [x] `.act-btn` 2px 圆角，主操作用墨色填充
   - [x] 删除 `pulse-ring` 动画与 `.dot` 脉冲

4. **外壳**
   - [x] 品牌改成 `KEEL` 字标 + 龙骨 SVG，去掉圆角方块 logo
   - [x] 侧栏 272px、选中态改 2px 左竖线
   - [x] 筛选胶囊改文字 + 下划线
   - [x] 底部状态栏收色，健康点改方块

5. **列表与详情**
   - [x] 位置刻度 `.ladder` 改 3×4px 无圆角
   - [x] 项目行加位置刻度；CTA 去箭头
   - [x] 「需要你处理」组加 2px 琥珀竖线
   - [x] 元信息 `·` 改中文逗号；侧栏时间右对齐
   - [x] 决策页 / Tab / 表格 / diff / 事件只换 token 与圆角

6. **验证与收尾**
   - [x] `console.test.ts` 断言新 token、去旧色、CTA 无箭头
   - [x] 更新 `console-guidelines.md` 视觉系统章节
   - [x] 明 / 暗 / 1024 / 900 逐屏截图验证
   - [x] `pnpm run check`

## 验证命令

```bash
pnpm run lint
pnpm run typecheck
pnpm vitest run src/cli/console.test.ts
pnpm run check
pnpm run console
```

## 回滚

- 只改 `console-page.ts`、测试与规范；回滚 = 还原这三个文件。
- Token 换血是全局的，若中途验收失败，先还原文件再分段重做，不做半套配色。

## 验收清单

- [x] 页面无 macOS 系统色残留
- [x] 状态标记无胶囊、无填充底、无脉冲
- [x] 元信息无 `·` 拼接，CTA 无 `→`
- [x] 明暗对比度达标
- [x] 1024 / 900 无横向溢出
- [x] `pnpm run check` 全绿
