/**
 * 架构边界强制规则。
 *
 * 这些规则不是代码风格偏好，它们是 docs/ 中架构约束的可执行形式：
 * 违反 = CI 红，而不是 code review 时靠人看出来。
 *
 * 背景（docs/03-domain-model.md §3 不变量 I5 的注）：
 *   「只写在文档里的边界，迟早会被一次『临时先这样』绕过。」
 *
 * 要放宽任何一条规则，走 ADR —— 不要在这里临时注释掉。
 */

/** 只允许依赖这些目录（用于 pathNot 白名单） */
const ONLY_SHARED_AND_GENERATED = '^src/(shared|generated)'

module.exports = {
  forbidden: [
    {
      name: 'execution-must-not-write-fact',
      severity: 'error',
      comment:
        '中心不变量：Execution Plane 绝不直接触碰 Fact Plane。' +
        '它的产出必须走 Proposal 通道，由 Control Plane 校验后代为落盘。' +
        '见 docs/03-domain-model.md §4、docs/05-contracts/session-manager.md §1。',
      from: { path: '^src/execution' },
      to: { path: '^src/fact' },
    },

    {
      name: 'fact-must-not-depend-on-execution',
      severity: 'error',
      comment:
        'Fact Plane 是被动的事实存储，不应知道谁在执行。' +
        '反向依赖会让事实层长出执行语义。',
      from: { path: '^src/fact' },
      to: { path: '^src/execution' },
    },

    {
      name: 'contracts-must-stay-pure',
      severity: 'error',
      comment:
        '契约层只描述形状，不依赖任何实现。' +
        '一旦它能 import 实现，interface 就会慢慢长出实现细节。' +
        '产物形状一律来自 src/generated（由 docs/schemas 生成）。',
      from: { path: '^src/contracts' },
      to: { pathNot: `^src/contracts|${ONLY_SHARED_AND_GENERATED}` },
    },

    {
      name: 'generated-must-not-import-local',
      severity: 'error',
      comment:
        'src/generated 由 docs/schemas 机械生成，不得依赖手写代码。' +
        '若生成物需要引用本地类型，说明生成器写错了。',
      from: { path: '^src/generated' },
      to: { path: '^src/(control|fact|execution|contracts)' },
    },

    {
      name: 'transition-must-be-pure',
      severity: 'error',
      comment:
        'ADR-0003 硬约束：状态转移必须是纯函数，不得内联 I/O。' +
        '本规则一次性挡住三类违规：Node 内置 I/O 模块、任意 npm 依赖、其他平面。' +
        '它同时服务于可重放性（docs/04-state-machine.md §5.3）' +
        '与「日后换 Temporal 不成为陷阱」这两件事。' +
        '注意：Date.now() / Math.random() 是全局而非 import，本规则看不见 —— ' +
        '那部分由 scripts/check-purity.ts 覆盖。',
      from: {
        path: '^src/control/transition',
        // 测试文件不是转移函数本身，它是验证转移函数的东西，需要 import vitest。
        // 放行它的口子由下面的 production-must-not-import-tests 堵住。
        pathNot: '\\.test\\.ts$',
      },
      to: { pathNot: `^src/control/transition|${ONLY_SHARED_AND_GENERATED}` },
    },

    {
      name: 'production-must-not-import-tests',
      severity: 'error',
      comment:
        '生产代码不得 import 测试文件。' +
        '若无此规则，transition-must-be-pure 对 .test.ts 的豁免就成了口子 —— ' +
        '可以把不纯的东西写进 .test.ts 再从 index.ts 引进来。',
      from: { pathNot: '\\.test\\.ts$' },
      to: { path: '\\.test\\.ts$' },
    },

    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖会让平面边界在事实上失效。',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // 包含仅类型导入：从 fact/ 引一个 type 到 execution/ 同样是边界信号
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
