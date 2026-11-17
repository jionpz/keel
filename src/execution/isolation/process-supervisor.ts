import type { ManagedOsSandbox } from './os-sandbox.js'
import { sandboxCommand } from './os-sandbox.js'

/**
 * supervisor 与工具进程继承同一个内核沙箱。signal 仅允许 same-sandbox，
 * 因此可用 SIG0 枚举成员；setsid、双重 fork、清空环境都不会脱离该边界。
 * stdin 是宿主持有的存活管道；宿主异常退出也会触发回收。
 */
const SUPERVISOR = String.raw`
const { spawn, execFileSync } = require('node:child_process');
let closing = false;
let child;
function members() {
  // /bin/ps 是 setuid 程序，沙箱内不能启动；pgrep 只返回 PID，不采集 argv/env。
  const rows = execFileSync('/usr/bin/pgrep', ['.'], {
    encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n');
  return rows.flatMap(row => {
    const pid = Number(row.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return [];
    try { process.kill(pid, 0); return [pid]; } catch (error) {
      if (error.code === 'EPERM' || error.code === 'ESRCH') return [];
      throw error;
    }
  });
}
function signal(pid, sig) {
  try { process.kill(pid, sig); } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}
async function finish(code) {
  if (closing) return;
  closing = true;
  try {
    // 先停止所有成员，防止回收过程中继续写入或派生进程。
    const stopped = new Set();
    for (let pass = 0; pass < 8; pass++) {
      const live = members();
      for (const pid of live) { signal(pid, 'SIGSTOP'); stopped.add(pid); }
      const next = members();
      if (next.every(pid => stopped.has(pid))) break;
      if (pass === 7) throw new Error('无法稳定停止 sandbox 成员');
    }
    for (const pid of members()) signal(pid, 'SIGKILL');
    for (let pass = 0; pass < 10; pass++) {
      if (members().length === 0) process.exit(code);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('sandbox 成员回收未完成');
  } catch (error) {
    console.error('managed supervisor: ' + error.message);
    process.exit(125);
  }
}
// 同一 profile 的另一次 sandbox-exec 有不同的内核身份；宿主必须不在本沙箱内。
try {
  process.kill(process.ppid, 0);
  console.error('managed supervisor: signal 边界未生效');
  process.exit(125);
} catch (error) {
  if (error.code !== 'EPERM') {
    console.error('managed supervisor: 无法确认宿主身份');
    process.exit(125);
  }
}
process.on('SIGTERM', () => void finish(143));
process.on('SIGINT', () => void finish(130));
process.on('SIGHUP', () => void finish(129));
process.stdin.on('end', () => void finish(125));
process.stdin.resume();
// 枚举能力缺失时在 Harness 启动前失败，不能启动后才发现无法回收。
try { members(); } catch (error) {
  console.error('managed supervisor: ' + error.message);
  process.exit(125);
}
child = spawn(process.argv[1], process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => void finish(127));
child.once('exit', (code, signal) => void finish(code ?? (signal === null ? 1 : 128)));
`

export function supervisedSandboxCommand(
  sandbox: ManagedOsSandbox,
  bin: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  return sandboxCommand(sandbox, process.execPath, ['-e', SUPERVISOR, '--', bin, ...args])
}
