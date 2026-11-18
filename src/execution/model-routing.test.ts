/**
 * 执行面模型路由 —— 部署配置、阶段/角色解析与启动期校验。
 *
 * 项目不预设任何模型 id 或 thinking 等级；这里用占位符验证机制：
 * 外部 profile 决定各 harness 的 stage / role 配置，未配置时交给 harness。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadModelProfilesFile,
  loadModelRoutingSettings,
  type ModelProfileDefinition,
  type ModelRouteTable,
  type ModelRoutingSettings,
  parseAllowlist,
  parseModelProfilesDocument,
  parseProfile,
  preflightModelRouting,
  resolveModelRoute,
} from './model-routing.js'

const OMP_TABLE: ModelRouteTable = {
  stages: {
    pm: { model: 'deployment/pm-model' },
    develop: { model: 'deployment/dev-model' },
    managed_investigate: { model: 'deployment/investigate-model' },
    tianwen: { model: 'deployment/tianwen-model' },
  },
  roles: {
    Reviewer: { model: 'deployment/reviewer-model' },
  },
}

const TEAM_PROFILE: ModelProfileDefinition = {
  omp: OMP_TABLE,
  pi: {
    stages: {
      develop: { model: 'deployment/pi-dev-model', thinking: 'high' },
    },
    roles: {
      Reviewer: { model: 'deployment/pi-reviewer-model', thinking: 'max' },
    },
  },
  claude: {
    stages: {
      develop: { model: 'deployment/claude-dev-model' },
    },
  },
}

const PROFILES = { 'team-a': TEAM_PROFILE }

function routing(allowlist: readonly string[] = []): ModelRoutingSettings {
  return { profile: 'team-a', profiles: { profiles: PROFILES }, allowlist }
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseProfile · KEEL_MODEL_PROFILE', () => {
  it('未设置 → 不做 profile 路由', () => {
    expect(parseProfile(undefined)).toEqual({ ok: true, value: undefined })
  })

  it('接受部署方定义的 profile 名，前后空白被裁掉', () => {
    expect(parseProfile(' team-a ')).toEqual({ ok: true, value: 'team-a' })
    expect(parseProfile('Team_A.v2')).toEqual({ ok: true, value: 'Team_A.v2' })
  })

  it('非法 / 空白 → CAPABILITY_UNSUPPORTED，点名变量', () => {
    for (const raw of ['', '   ', 'team/a', '-team', '企业']) {
      const r = parseProfile(raw)
      expect(r.ok, `${JSON.stringify(raw)} 应被拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
      expect(r.error.detail).toContain('KEEL_MODEL_PROFILE')
    }
  })
})

describe('parseAllowlist · KEEL_MODEL_ALLOWLIST', () => {
  it('未设置 → 空清单（不校验）', () => {
    expect(parseAllowlist(undefined)).toEqual({ ok: true, value: [] })
  })

  it('逗号分隔，前后空白被裁掉', () => {
    const r = parseAllowlist(' model/a , model/b ')
    expect(r.ok && r.value).toEqual(['model/a', 'model/b'])
  })

  it('空项 / 全空白 → 拒绝，不静默跳过', () => {
    for (const raw of ['', 'a,,b', 'a,', ',a', '   ']) {
      const r = parseAllowlist(raw)
      expect(r.ok, `${JSON.stringify(raw)} 应被拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.detail).toContain('KEEL_MODEL_ALLOWLIST')
    }
  })
})

describe('parseModelProfilesDocument · 部署方配置结构', () => {
  it('接受按 harness 分表的 stage / role 配置', () => {
    const r = parseModelProfilesDocument({ profiles: { 'team-a': TEAM_PROFILE } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.profiles['team-a']?.omp?.stages?.develop?.model).toBe('deployment/dev-model')
    expect(r.value.profiles['team-a']?.pi?.roles?.Reviewer?.thinking).toBe('max')
  })

  it('拒绝未知顶层字段和非对象', () => {
    expect(parseModelProfilesDocument([]).ok).toBe(false)
    expect(parseModelProfilesDocument({ profiles: PROFILES, extra: true }).ok).toBe(false)
  })

  it('profiles 必须是非空对象', () => {
    expect(parseModelProfilesDocument({}).ok).toBe(false)
    expect(parseModelProfilesDocument({ profiles: {} }).ok).toBe(false)
    expect(parseModelProfilesDocument({ profiles: [] }).ok).toBe(false)
  })

  it('拒绝无法被 KEEL_MODEL_PROFILE 选中的 profile 名', () => {
    for (const name of ['', ' team-a', 'team/a', '-team', '企业']) {
      const r = parseModelProfilesDocument({ profiles: { [name]: TEAM_PROFILE } })
      expect(r.ok, JSON.stringify(name)).toBe(false)
    }
  })

  it('拒绝未知 harness / stage / role', () => {
    const unknownHarness = parseModelProfilesDocument({
      profiles: { p: { codex: { stages: { develop: { model: 'm' } } } } },
    })
    expect(unknownHarness.ok).toBe(false)

    const unknownStage = parseModelProfilesDocument({
      profiles: { p: { omp: { stages: { unknown_stage: { model: 'm' } } } } },
    })
    expect(unknownStage.ok).toBe(false)

    const unknownRole = parseModelProfilesDocument({
      profiles: { p: { omp: { roles: { UnknownRole: { model: 'm' } } } } },
    })
    expect(unknownRole.ok).toBe(false)
  })

  it('拒绝空表、空条目、未知字段与空值', () => {
    const cases: unknown[] = [
      { profiles: { p: {} } },
      { profiles: { p: { omp: {} } } },
      { profiles: { p: { omp: { stages: {} } } } },
      { profiles: { p: { omp: { stages: { develop: {} } } } } },
      { profiles: { p: { omp: { stages: { develop: { model: '   ' } } } } } },
      { profiles: { p: { omp: { stages: { develop: { model: 'm', extra: true } } } } } },
      { profiles: { p: { omp: { stages: { develop: { model: 1 } } } } } },
    ]
    for (const raw of cases) {
      const r = parseModelProfilesDocument(raw)
      expect(r.ok, JSON.stringify(raw)).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    }
  })
})

describe('loadModelRoutingSettings · 环境变量', () => {
  it('未设置 profile → 只保留 allowlist', () => {
    const r = loadModelRoutingSettings({
      KEEL_MODEL_ALLOWLIST: 'model/a',
    })
    expect(r).toEqual({ ok: true, value: { allowlist: ['model/a'] } })
  })

  it('选了 profile 却没有配置文件 → 启动即失败', () => {
    const r = loadModelRoutingSettings({ KEEL_MODEL_PROFILE: 'team-a' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toContain('KEEL_MODEL_PROFILES_FILE')
  })

  it('读取部署方 JSON，并拒绝不存在的 profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-model-profiles-'))
    tempDirs.push(dir)
    const file = join(dir, 'profiles.json')
    writeFileSync(file, JSON.stringify({ profiles: PROFILES }), 'utf8')

    const loaded = loadModelRoutingSettings({
      KEEL_MODEL_PROFILE: 'team-a',
      KEEL_MODEL_PROFILES_FILE: file,
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.profile).toBe('team-a')
    expect(loaded.value.profiles?.profiles['team-a']?.omp?.stages?.develop?.model).toBe(
      'deployment/dev-model',
    )

    const missing = loadModelRoutingSettings({
      KEEL_MODEL_PROFILE: 'team-b',
      KEEL_MODEL_PROFILES_FILE: file,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.detail).toContain('team-b')
    expect(missing.error.detail).toContain('team-a')
  })

  it('坏 JSON → CAPABILITY_UNSUPPORTED，消息点名文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-model-profiles-'))
    tempDirs.push(dir)
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{not json', 'utf8')

    const r = loadModelProfilesFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain(file)
  })
})

describe('resolveModelRoute · override > role > stage > 不传', () => {
  it('没有 profile / override → 不传模型与 thinking', () => {
    const r = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Developer',
      routing: { allowlist: [] },
    })
    expect(r).toEqual({ ok: true, value: {} })
  })

  it('没有 profile 时显式 override 仍生效', () => {
    const r = resolveModelRoute({
      harness: 'claude',
      stage: 'develop',
      role: 'Developer',
      override: ' override/model ',
      routing: { allowlist: [] },
    })
    expect(r).toEqual({ ok: true, value: { model: 'override/model' } })
  })

  it('stage 配置生效，包括 managed_investigate / tianwen', () => {
    const investigate = resolveModelRoute({
      harness: 'omp',
      stage: 'managed_investigate',
      role: 'Investigator',
      routing: routing(),
    })
    expect(investigate.ok && investigate.value.model).toBe('deployment/investigate-model')

    const tianwen = resolveModelRoute({
      harness: 'omp',
      stage: 'tianwen',
      role: 'Tianwen',
      routing: routing(),
    })
    expect(tianwen.ok && tianwen.value.model).toBe('deployment/tianwen-model')

    const claude = resolveModelRoute({
      harness: 'claude',
      stage: 'develop',
      role: 'Developer',
      routing: routing(),
    })
    expect(claude.ok && claude.value.model).toBe('deployment/claude-dev-model')
  })

  it('role 覆盖 stage', () => {
    const r = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Reviewer',
      routing: routing(),
    })
    expect(r.ok && r.value.model).toBe('deployment/reviewer-model')
  })

  it('override 压过 role / stage，thinking 仍按 role / stage 独立解析', () => {
    const r = resolveModelRoute({
      harness: 'pi',
      stage: 'develop',
      role: 'Reviewer',
      override: 'override/model',
      routing: routing(),
    })
    expect(r.ok && r.value).toEqual({ model: 'override/model', thinking: 'max' })

    const stageOnly = resolveModelRoute({
      harness: 'pi',
      stage: 'develop',
      role: 'Developer',
      routing: routing(),
    })
    expect(stageOnly.ok && stageOnly.value).toEqual({
      model: 'deployment/pi-dev-model',
      thinking: 'high',
    })
  })

  it('选中 profile 但缺少该 harness → 拒绝，不静默当作未配置', () => {
    const r = resolveModelRoute({
      harness: 'claude',
      stage: 'develop',
      role: 'Developer',
      routing: {
        profile: 'team-a',
        profiles: { profiles: { 'team-a': { omp: OMP_TABLE } } },
        allowlist: [],
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toContain('harness=claude')
  })

  it('未知 harness → 拒绝', () => {
    const r = resolveModelRoute({
      harness: 'codex',
      stage: 'develop',
      role: 'Developer',
      routing: routing(),
    })
    expect(r.ok).toBe(false)
  })

  it('omp / claude 配了 thinking → 拒绝，不静默丢弃', () => {
    const ompThinking: ModelProfileDefinition = {
      omp: { stages: { develop: { model: 'm', thinking: 'high' } } },
    }
    const omp = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Developer',
      routing: {
        profile: 'team-a',
        profiles: { profiles: { 'team-a': ompThinking } },
        allowlist: [],
      },
    })
    expect(omp.ok).toBe(false)

    const claudeThinking: ModelProfileDefinition = {
      claude: { stages: { develop: { model: 'm', thinking: 'high' } } },
    }
    const claude = resolveModelRoute({
      harness: 'claude',
      stage: 'develop',
      role: 'Developer',
      routing: {
        profile: 'team-a',
        profiles: { profiles: { 'team-a': claudeThinking } },
        allowlist: [],
      },
    })
    expect(claude.ok).toBe(false)
  })

  it('allowlist 约束 stage / role / override；未配置模型时不做无意义拒绝', () => {
    const deniedStage = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Developer',
      routing: routing(['deployment/pm-model']),
    })
    expect(deniedStage.ok).toBe(false)
    if (!deniedStage.ok) {
      expect(deniedStage.error.detail).toContain('deployment/dev-model')
      expect(deniedStage.error.detail).toContain('KEEL_MODEL_ALLOWLIST')
    }

    const deniedOverride = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Developer',
      override: 'override/model',
      routing: routing(['deployment/dev-model']),
    })
    expect(deniedOverride.ok).toBe(false)

    const noModel = resolveModelRoute({
      harness: 'omp',
      stage: 'qa',
      role: 'QA',
      routing: routing(['deployment/dev-model']),
    })
    expect(noModel).toEqual({ ok: true, value: {} })
  })

  it('空白 override 拒绝，不静默回退 profile', () => {
    const r = resolveModelRoute({
      harness: 'omp',
      stage: 'develop',
      role: 'Developer',
      override: '   ',
      routing: routing(),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
  })
})

describe('preflightModelRouting · 启动前检查全部配置', () => {
  it('没有 profile / override：非空 allowlist 也不误报', () => {
    expect(
      preflightModelRouting({
        harness: 'omp',
        routing: { allowlist: ['model/a'] },
      }),
    ).toEqual({ ok: true, value: undefined })
  })

  it('显式 override 必须命中 allowlist', () => {
    expect(
      preflightModelRouting({
        harness: 'claude',
        routing: { allowlist: ['model/a'] },
        override: 'model/a',
      }).ok,
    ).toBe(true)

    const denied = preflightModelRouting({
      harness: 'claude',
      routing: { allowlist: ['model/a'] },
      override: 'model/b',
    })
    expect(denied.ok).toBe(false)
  })

  it('检查 profile 下所有 stage / role，不只检查当前可能跑的条目', () => {
    const r = preflightModelRouting({
      harness: 'omp',
      routing: routing(['deployment/pm-model', 'deployment/dev-model']),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('deployment/investigate-model')
  })

  it('覆盖全部条目 → 放行', () => {
    const r = preflightModelRouting({
      harness: 'omp',
      routing: routing([
        'deployment/pm-model',
        'deployment/dev-model',
        'deployment/investigate-model',
        'deployment/tianwen-model',
        'deployment/reviewer-model',
      ]),
    })
    expect(r.ok).toBe(true)
  })

  it('不支持 thinking 的 harness 即使当前不跑该 stage 也在启动期拒绝', () => {
    const r = preflightModelRouting({
      harness: 'omp',
      routing: {
        profile: 'team-a',
        profiles: {
          profiles: {
            'team-a': {
              omp: { stages: { review: { model: 'm', thinking: 'high' } } },
            },
          },
        },
        allowlist: [],
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('thinking')
  })

  it('选中 profile 但缺少该 harness → 启动期拒绝', () => {
    const r = preflightModelRouting({
      harness: 'pi',
      routing: routing(),
    })
    expect(r.ok).toBe(true)

    const missing = preflightModelRouting({
      harness: 'claude',
      routing: {
        profile: 'team-a',
        profiles: { profiles: { 'team-a': { omp: OMP_TABLE } } },
        allowlist: [],
      },
    })
    expect(missing.ok).toBe(false)
  })
})
