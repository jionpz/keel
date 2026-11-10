import { describe, expect, it } from 'vitest'
import { sha256CanonicalJson } from '../shared/canonical-json.js'
import {
  KEEL_STAGE_PROFILE,
  parseToolPolicy,
  resolveKeelStageToolPolicy,
  resolveToolPolicy,
  type ToolPolicyDocument,
} from './tool-policy.js'

function makePolicy(): ToolPolicyDocument {
  const body = {
    protocol_version: '1.0' as const,
    source_commit: '0123456789abcdef',
    stages: { execute: 'developer', verify: 'verifier', clarify: 'analyst' },
    profiles: {
      developer: {
        role: 'developer',
        capabilities: ['read', 'write', 'bash', 'delegate'] as const,
        optional_capabilities: ['web_search'] as const,
      },
      verifier: {
        role: 'verifier',
        capabilities: ['read', 'grep', 'bash'] as const,
        optional_capabilities: [] as const,
      },
      analyst: {
        role: 'analyst',
        capabilities: ['read', 'grep'] as const,
        optional_capabilities: ['web_search'] as const,
      },
    },
    harnesses: {
      pi: {
        read: { native: ['read'] },
        write: { native: ['write'] },
        bash: { native: ['bash'] },
        delegate: { native: ['Agent'], extension: true },
        grep: { native: ['grep'], fallback: 'bash' },
        web_search: { native: ['web_search'], extension: true },
      },
      'claude-code': {
        read: { native: ['Read'] },
        write: { native: ['Write'] },
        bash: { native: ['Bash'] },
        delegate: { native: ['Task', 'Agent'] },
        grep: { native: ['Grep'], fallback: 'Bash' },
        web_search: { native: ['WebSearch'] },
      },
    },
  }
  return { ...body, content_digest: sha256CanonicalJson(body) }
}

describe('tool policy 解析与解析器', () => {
  it('digest 与规范化 JSON 一致，重复解析稳定', () => {
    const policy = makePolicy()
    const once = parseToolPolicy(policy)
    const twice = parseToolPolicy(JSON.parse(JSON.stringify(policy)))
    expect(once.ok).toBe(true)
    expect(twice.ok).toBe(true)
    if (!once.ok || !twice.ok) return
    expect(once.value.content_digest).toBe(twice.value.content_digest)
    expect(once.value).toEqual(twice.value)
  })

  it('拒绝被篡改的 digest 和未知能力', () => {
    const policy = makePolicy()
    const tampered = { ...policy, content_digest: '0'.repeat(64) }
    expect(parseToolPolicy(tampered).ok).toBe(false)
    const unknown = {
      ...policy,
      profiles: {
        ...policy.profiles,
        developer: {
          ...policy.profiles.developer,
          capabilities: ['read', 'deploy'],
        },
      },
    }
    expect(parseToolPolicy(unknown).ok).toBe(false)
  })

  it('按真实 inventory 选原生名，缺必需工具拒绝', () => {
    const policy = makePolicy()
    const ok = resolveToolPolicy(policy, {
      stage: 'execute',
      harness: 'pi',
      inventory: ['read', 'write', 'bash', 'Agent'],
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.value.native_tools).toEqual(['read', 'write', 'bash', 'Agent'])
    expect(ok.value.permissions.allowed_tools).toEqual(ok.value.native_tools)
    expect(ok.value.permissions.mode).toBe('deny_unlisted')

    const missing = resolveToolPolicy(policy, {
      stage: 'execute',
      harness: 'pi',
      inventory: ['read', 'write'],
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.detail).toContain('bash')
  })

  it('可选工具缺失只进 missing_optional，不假装可用', () => {
    const r = resolveToolPolicy(makePolicy(), {
      stage: 'execute',
      harness: 'pi',
      inventory: ['read', 'write', 'bash', 'Agent'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.missing_optional).toEqual(['web_search'])
    expect(r.value.native_tools).not.toContain('web_search')
  })

  it('搜索回退 Bash 必须显式允许并记录 degradation', () => {
    const policy = makePolicy()
    const accepted = resolveToolPolicy(policy, {
      stage: 'verify',
      harness: 'claude-code',
      inventory: ['Read', 'Bash'],
      allowShellFallback: true,
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value.native_tools).toEqual(['Read', 'Bash'])
    expect(accepted.value.degradations).toEqual([
      {
        capability: 'grep',
        expected_native: ['Grep'],
        fallback_native: 'Bash',
        reason: '当前 harness 清单没有原生搜索工具，调用方显式允许 Bash 回退',
      },
    ])
  })

  it('profile 自带 bash 也不等于允许搜索回退', () => {
    const rejected = resolveToolPolicy(makePolicy(), {
      stage: 'verify',
      harness: 'claude-code',
      inventory: ['Read', 'Bash'],
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.detail).toContain('需要显式允许')
  })

  it('只读 profile 拒绝 shell 回退，除非调用方显式允许', () => {
    const policy = makePolicy()
    const rejected = resolveToolPolicy(policy, {
      stage: 'clarify',
      harness: 'claude-code',
      inventory: ['Read', 'Bash'],
    })
    expect(rejected.ok).toBe(false)

    const accepted = resolveToolPolicy(policy, {
      stage: 'clarify',
      harness: 'claude-code',
      inventory: ['Read', 'Bash'],
      allowShellFallback: true,
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value.native_tools).toEqual(['Read', 'Bash'])
    expect(accepted.value.degradations).toHaveLength(1)
  })

  it('Claude delegate 按清单选 Task 或 Agent', () => {
    const policy = makePolicy()
    const task = resolveToolPolicy(policy, {
      stage: 'execute',
      harness: 'claude-code',
      inventory: ['Read', 'Write', 'Bash', 'Task'],
    })
    expect(task.ok && task.value.native_tools).toContain('Task')
    const agent = resolveToolPolicy(policy, {
      stage: 'execute',
      harness: 'claude-code',
      inventory: ['Read', 'Write', 'Bash', 'Agent'],
    })
    expect(agent.ok && agent.value.native_tools).toContain('Agent')
  })

  it('Keel 阶段映射到 jstack profile', () => {
    const policy = makePolicy()
    const r = resolveKeelStageToolPolicy(policy, 'develop', {
      harness: 'pi',
      inventory: ['read', 'write', 'bash', 'Agent'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.profile).toBe('developer')
    expect(KEEL_STAGE_PROFILE.qa).toBe('verifier')
  })

  it('未知 profile 和缺失阶段引用都拒绝', () => {
    const policy = makePolicy()
    expect(resolveToolPolicy(policy, { role: 'nope', harness: 'pi', inventory: ['read'] }).ok).toBe(
      false,
    )
    expect(
      resolveToolPolicy(policy, { stage: 'land', harness: 'pi', inventory: ['read'] }).ok,
    ).toBe(false)
  })
})
