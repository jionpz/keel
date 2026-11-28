import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProjectChecks } from '../project-verification.js'

it.skipIf(process.platform !== 'darwin')(
  '在真实沙箱运行前后端检查，拒绝写仓库或读取外部文件与宿主凭据',
  async () => {
    const base = await mkdtemp('/tmp/keel-project-verification-test-')
    const workspace = join(base, 'repo')
    const outside = join(base, 'host-secret')
    const rulePath = join(workspace, 'AGENTS.md')
    try {
      const python = execFileSync('/usr/bin/xcrun', ['--find', 'python3'], {
        encoding: 'utf8',
      }).trim()
      await Promise.all([
        mkdir(join(workspace, 'frontend'), { recursive: true }),
        mkdir(join(workspace, 'backend'), { recursive: true }),
        writeFile(outside, 'host secret'),
      ])
      execFileSync('/usr/bin/git', ['init', '-q', workspace], { stdio: 'pipe' })
      await Promise.all([
        writeFile(rulePath, 'echo this command has no authority\n'),
        writeFile(
          join(workspace, 'frontend', 'guard.test.mjs'),
          `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { equal, throws } from 'node:assert/strict';
equal(process.env.GITHUB_TOKEN, undefined);
throws(() => readFileSync(${JSON.stringify(outside)}));
throws(() => readdirSync('/private/var/log'));
throws(() => writeFileSync('AGENTS.md', 'weaken gate'));
throws(() => writeFileSync('.git/config', 'weaken gate'));
console.log('frontend executed');
`,
        ),
        writeFile(
          join(workspace, 'backend', 'guard.py'),
          "import sys, tempfile\nwith tempfile.TemporaryDirectory():\n    print('backend executed')\nprint('x' * 8000, file=sys.stderr)\nsys.exit(7)\n",
        ),
      ])
      vi.stubEnv('GITHUB_TOKEN', 'fixture-token')
      const result = await runProjectChecks({
        workspace,
        timeoutMs: 10000,
        checks: [
          {
            id: 'frontend',
            kind: 'local',
            argv: [process.execPath, '--test', 'frontend/guard.test.mjs'],
          },
          { id: 'backend', kind: 'local', argv: [python, 'backend/guard.py'] },
        ],
      })
      if (!result.ok) throw new Error(result.error.detail)
      expect(result.value[1]?.output_excerpt).toContain('（输出超过摘录上限）')
      expect(result).toMatchObject({
        ok: true,
        value: [
          {
            id: 'frontend',
            exit_code: 0,
            output_excerpt: expect.stringContaining('frontend executed'),
          },
          {
            id: 'backend',
            exit_code: 7,
            output_excerpt: expect.stringContaining('backend executed'),
          },
        ],
      })
      expect(await readFile(rulePath, 'utf8')).toEqual('echo this command has no authority\n')
    } finally {
      vi.unstubAllEnvs()
      await rm(base, { recursive: true, force: true })
    }
  },
  15000,
)
