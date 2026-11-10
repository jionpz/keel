import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MODEL = 'opencode-go/deepseek-v4.1-flash'
const ANSWER = '测试操作者决定：选择A灯塔'
const QUESTION =
  '请阅读 README.md 与 release-choice.md，说明这个夹具如何启动；在 release-choice.md 的展示名称偏好上，必须先询问测试操作者选择 A灯塔 还是 B海风，并结合两个文件说明依据。不要自行假定偏好；需要该决定时使用 waiting_decision。'
const STAGE_MS = 240_000
const RECOVERY_MS = 360_000
const POLL_MS = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DB_NAME = /^keel_jt01_[a-z0-9_]+$/
const GATEWAY_PROBE =
  'const net=require("node:net");const s=net.connect(3425,"127.0.0.1");const t=setTimeout(()=>{s.destroy();process.exit(1)},1000);s.on("connect",()=>{clearTimeout(t);s.end();process.exit(0)});s.on("error",()=>{clearTimeout(t);process.exit(1)});'
const MODEL_SCAN =
  'const fs=require("node:fs");const skip=new Set([process.pid,process.ppid]);const found=[];for(const name of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(name))continue;const pid=Number(name);if(skip.has(pid))continue;let cmd;try{cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8")}catch{continue}const parts=cmd.split("\\0").filter(Boolean);if(!parts.some(p=>p==="/usr/local/bin/omp"||p.endsWith("/@oh-my-pi/pi-coding-agent/dist/cli.js")))continue;if(!parts.includes("--mode=json"))continue;let stat;try{stat=fs.readFileSync("/proc/"+pid+"/stat","utf8")}catch{continue}const at=stat.lastIndexOf(")");if(at<0)continue;const fields=stat.slice(at+2).split(" ");found.push({pid,starttime:fields[19]})}process.stdout.write(JSON.stringify(found));'
const WORKER_CMDLINE_PROBE =
  'const fs=require("node:fs");const [pid,cli]=process.argv.slice(1);const fail=()=>process.exit(1);if(!/^[0-9]+$/.test(pid||"")||!cli)fail();let raw;try{raw=fs.readFileSync("/proc/"+pid+"/cmdline","utf8")}catch{fail()}const parts=raw.split("\\0");process.exit(parts.length>=4&&parts[0]==="node"&&parts[1]===cli&&parts[2]==="managed"&&parts[3]==="worker"?0:1);'
const MODEL_KILL =
  'const fs=require("node:fs");const pid=Number(process.argv[1]);const start=process.argv[2];if(!Number.isInteger(pid)||pid<=1){process.stdout.write(JSON.stringify({pid,killed:false,reason:"invalid-pid"}));process.exit(0)}let stat;try{stat=fs.readFileSync("/proc/"+pid+"/stat","utf8")}catch{process.stdout.write(JSON.stringify({pid,killed:false,reason:"gone"}));process.exit(0)}const at=stat.lastIndexOf(")");const fields=stat.slice(at+2).split(" ");if(fields[19]!==start){process.stdout.write(JSON.stringify({pid,killed:false,reason:"reused"}));process.exit(0)}let group=true;try{process.kill(-pid,"SIGKILL")}catch{group=false;try{process.kill(pid,"SIGKILL")}catch{process.stdout.write(JSON.stringify({pid,killed:false,reason:"kill-failed"}));process.exit(0)}}process.stdout.write(JSON.stringify({pid,killed:true,group}));'

let evidenceDir = null
let containerName = null
let containerId = null
let ownerUrl = null
let cliInContainer = null
let taskId = null
let state = { ok: false, steps: [], workers: [] }
const workers = []

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function truncate(value) {
  return String(value ?? '')
    .trim()
    .slice(-800)
}

function now() {
  return new Date().toISOString()
}

function writeState() {
  if (evidenceDir === null) return
  state.workers = workers.map((worker) => ({
    role: worker.role,
    pid: worker.pid,
    attempt_id: worker.attemptId,
    model: worker.model,
    started_at: worker.started_at,
    signal_sent_at: worker.signal_sent_at,
    killed_at: worker.killed_at,
    exit: worker.exit,
  }))
  writeFileSync(join(evidenceDir, 'fault-evidence.json'), `${JSON.stringify(state, null, 2)}\n`)
}

function step(name, detail = {}) {
  state.steps.push({ at: now(), name, ...detail })
  writeState()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: options.env ?? process.env,
  })
  if (result.error) fail(`${command} 无法执行：${result.error.message}`)
  return {
    code: result.status ?? -1,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options)
  if (result.code !== 0)
    fail(`${command} 退出 ${result.code}：${truncate(result.stderr || result.stdout)}`)
  return result
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function realDir(path, label) {
  assert(isAbsolute(path), `${label} 必须是绝对路径`)
  let resolved
  try {
    resolved = realpathSync(path)
  } catch {
    fail(`找不到${label}：${path}`)
  }
  assert(statSync(resolved).isDirectory(), `${label} 不是目录：${path}`)
  return resolved
}

function realFile(path, label) {
  assert(isAbsolute(path), `${label} 必须是绝对路径`)
  let resolved
  try {
    resolved = realpathSync(path)
  } catch {
    fail(`找不到${label}：${path}`)
  }
  assert(statSync(resolved).isFile(), `${label} 不是普通文件：${path}`)
  return resolved
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function inside(child, parent) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function parseArgs(argv) {
  const allowed = new Set(['--evidence', '--bun-package', '--point'])
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!allowed.has(arg)) fail(`不支持的参数：${arg}`)
    if (values.has(arg)) fail(`${arg} 重复`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--') || value.trim() === '') fail(`${arg} 缺少值`)
    values.set(arg, value)
    index++
  }
  for (const name of allowed) if (!values.has(name)) fail(`缺少 ${name}`)
  const evidence = values.get('--evidence')
  const bunPackage = values.get('--bun-package')
  const point = values.get('--point')
  assert(isAbsolute(evidence), '--evidence 必须是绝对路径')
  assert(isAbsolute(bunPackage), '--bun-package 必须是绝对路径')
  assert(
    point === 'before-question' || point === 'after-answer',
    '--point 只接受 before-question|after-answer',
  )
  return { evidence, bunPackage, point }
}

function loadBase(evidencePath) {
  const evidenceFile = realFile(evidencePath, '--evidence')
  const base = JSON.parse(readFileSync(evidenceFile, 'utf8'))
  assert(base.ok === true, 'base evidence 的 ok 不是 true')
  assert(base.harness_kind === 'native-omp', 'base evidence 不是 native-omp')
  assert(base.harness_version === 'omp/18.11.1', 'base harness_version 不是 omp/18.11.1')
  const runtime = base.runtime
  assert(runtime && typeof runtime === 'object', 'base evidence 缺少 runtime')
  assert(runtime.omp_version === 'omp/18.11.1', 'base runtime.omp_version 不是 omp/18.11.1')
  assert(runtime.omp_package_version === '18.11.1', 'base OMP package 版本不是 18.11.1')
  assert(runtime.model === MODEL, `base runtime.model 不是 ${MODEL}`)
  assert(
    typeof runtime.bun_version === 'string' && runtime.bun_version.trim(),
    'base 缺少 Bun 版本',
  )
  assert(
    typeof runtime.omp_package_entry_sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(runtime.omp_package_entry_sha256),
    'base 缺少 OMP 入口 SHA256',
  )
  assert(isAbsolute(base.evidence_dir), 'base evidence_dir 必须是绝对路径')
  const root = realpathSync(ROOT)
  const baseDir = realDir(base.evidence_dir, 'base evidence_dir')
  assert(inside(baseDir, join(root, '.keel')), 'base evidence_dir 不在本 worktree 的 .keel 内')
  assert(realpathSync(dirname(evidenceFile)) === baseDir, 'evidence.json 不在 base evidence_dir 内')
  const fixture = realDir(join(baseDir, 'fixture'), 'base fixture')
  const runtimeDir = realDir(join(baseDir, 'runtime'), 'base runtime')
  assert(inside(fixture, baseDir), 'base fixture 不在 base evidence_dir 内')
  assert(inside(runtimeDir, baseDir), 'base runtime 不在 base evidence_dir 内')
  const runtimeCli = realFile(join(runtimeDir, 'cli/index.js'), 'base runtime CLI')
  const jstackPackage = realFile(join(baseDir, 'jstack-package.json'), 'base jstack package')
  for (const name of ['README.md', 'release-choice.md'])
    realFile(join(fixture, name), `base fixture/${name}`)
  assert(isAbsolute(base.omp_package), 'base omp_package 必须是绝对路径')
  const ompModules = realDir(base.omp_package, 'base OMP node_modules')
  const ompPackage = realDir(join(ompModules, '@oh-my-pi/pi-coding-agent'), 'base OMP package')
  const ompEntry = realFile(join(ompPackage, 'dist/cli.js'), 'base OMP entry')
  assert(isExecutable(ompEntry), `base OMP entry 不可执行：${ompEntry}`)
  const ompPackageVersion = JSON.parse(
    readFileSync(join(ompPackage, 'package.json'), 'utf8'),
  ).version
  assert(
    ompPackageVersion === '18.11.1',
    `base OMP package.json 版本不是 18.11.1：${ompPackageVersion}`,
  )
  const ompEntrySha256 = sha256File(ompEntry)
  assert(
    ompEntrySha256 === runtime.omp_package_entry_sha256,
    'base OMP 入口 SHA256 与 base runtime 记录不一致',
  )
  const repoId = base.status?.repo_id
  assert(UUID.test(repoId ?? ''), 'base status.repo_id 不是 UUID')
  assert(base.status?.status === 'DONE', 'base task 不是 DONE')
  assert(base.status?.report?.outcome === 'completed', 'base report 不是 completed')
  assert(UUID.test(base.task_id ?? ''), 'base task_id 不是 UUID')
  assert(DB_NAME.test(base.database ?? ''), `base 数据库名不符合 keel_jt01_*：${base.database}`)
  return {
    evidenceFile,
    evidenceDir: baseDir,
    database: base.database,
    harnessKind: base.harness_kind,
    harnessVersion: base.harness_version,
    ompVersion: runtime.omp_version,
    bunVersion: runtime.bun_version,
    bunPackageVersion: runtime.bun_package_version,
    model: runtime.model,
    thinking: runtime.thinking,
    ompModules,
    ompPackage,
    ompEntry,
    ompEntrySha256,
    ompPackageVersion,
    repoId,
    taskId: base.task_id,
    questionId: base.question_id,
    status: base.status,
    fixture,
    runtimeDir,
    runtimeCli,
    jstackPackage,
    runtime,
  }
}

function loadBun(path, base) {
  const root = realDir(path, '--bun-package')
  const pkg = realFile(join(root, 'package.json'), 'Bun package.json')
  const bin = realFile(join(root, 'bin/bun'), 'Bun 可执行文件')
  assert(isExecutable(bin), `Bun 不可执行：${bin}`)
  const version = JSON.parse(readFileSync(pkg, 'utf8')).version
  assert(
    version === base.bunPackageVersion,
    `Bun package 版本不一致：${version} != ${base.bunPackageVersion}`,
  )
  return { root, bin, version }
}

function prepareDatabase(base) {
  const role = mustRun('psql', [
    'postgres://localhost:5432/postgres',
    '-Atc',
    'select current_user',
  ]).stdout.trim()
  assert(/^[A-Za-z0-9_.-]+$/.test(role), `Postgres 角色无法安全写入 URL：${role}`)
  ownerUrl = `postgres://localhost:5432/${base.database}`
  const current = mustRun('psql', [ownerUrl, '-Atc', 'select current_database()']).stdout.trim()
  assert(current === base.database, `current_database 不是 ${base.database}：${current}`)
  const oldTask = psqlJson(
    `SELECT json_build_object('id',id,'status',status) FROM managed_task WHERE id='${base.taskId}'`,
  )
  assert(oldTask?.status === 'DONE', 'base 数据库中的旧 task 不是 DONE')
  return {
    role,
    ownerUrl,
    containerUrl: `postgres://${role}@host.docker.internal:5432/${base.database}`,
  }
}

function psqlText(sql) {
  return mustRun('psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]).stdout.trim()
}

function psqlJson(sql) {
  const text = psqlText(sql)
  return text === '' ? null : JSON.parse(text)
}

function taskSnapshotSql(excludeId = null) {
  const where = excludeId === null ? '' : ` WHERE id<>'${excludeId}'`
  return `SELECT coalesce(json_agg(json_build_object('id',id,'status',status,'phase',phase,'attempts',attempts,'failures',failures,'lease_token',lease_token,'lease_until',lease_until,'updated_at',updated_at,'pending_question_id',pending_question_id,'report',report,'answers',answers) ORDER BY id),'[]'::json) FROM managed_task${where}`
}

function dbTaskIds() {
  return psqlJson("SELECT coalesce(json_agg(id ORDER BY id),'[]'::json) FROM managed_task")
}

function dbTask() {
  return psqlJson(`SELECT to_jsonb(t) FROM managed_task t WHERE t.id='${taskId}'`)
}

function dbStatus() {
  return psqlText(`SELECT status FROM managed_task WHERE id='${taskId}'`)
}

function dbQuestions() {
  return psqlJson(
    `SELECT coalesce(json_agg(to_jsonb(q) ORDER BY q.created_at),'[]'::json) FROM managed_question q WHERE q.task_id='${taskId}'`,
  )
}

function dbRunningAttempt() {
  return psqlJson(
    `SELECT json_build_object('id',id,'phase',phase,'status',status,'lease_token',lease_token,'context',context,'started_at',started_at) FROM managed_attempt WHERE task_id='${taskId}' AND status='RUNNING' ORDER BY started_at DESC,id DESC LIMIT 1`,
  )
}

function dbAudit() {
  return psqlJson(`SELECT json_build_object(
    'task',(SELECT to_jsonb(t) FROM managed_task t WHERE t.id='${taskId}'),
    'events',(SELECT coalesce(json_agg(json_build_object('seq',e.seq,'type',e.type,'payload',e.payload,'occurred_at',e.occurred_at) ORDER BY e.seq),'[]'::json) FROM managed_event e WHERE e.task_id='${taskId}'),
    'attempts',(SELECT coalesce(json_agg(json_build_object('id',a.id,'task_id',a.task_id,'phase',a.phase,'status',a.status,'result',a.result,'usage',a.usage,'error',a.error,'lease_token',a.lease_token,'started_at',a.started_at,'ended_at',a.ended_at) ORDER BY a.started_at,a.id),'[]'::json) FROM managed_attempt a WHERE a.task_id='${taskId}'),
    'questions',(SELECT coalesce(json_agg(to_jsonb(q) ORDER BY q.created_at),'[]'::json) FROM managed_question q WHERE q.task_id='${taskId}')
  )`)
}

function dbLeaseEvent(token) {
  assert(UUID.test(token ?? ''), 'lease token 不是 UUID')
  return psqlJson(
    `SELECT json_build_object('seq',seq,'type',type,'payload',payload,'occurred_at',occurred_at) FROM managed_event WHERE task_id='${taskId}' AND type='ManagedLeaseExpired' AND payload->>'token'='${token}' ORDER BY seq LIMIT 1`,
  )
}

function dexec(args, options = {}) {
  return run('docker', ['exec', containerName, ...args], options)
}

function dexecMust(args, options = {}) {
  const result = dexec(args, options)
  if (result.code !== 0)
    fail(`docker exec 退出 ${result.code}：${truncate(result.stderr || result.stdout)}`)
  return result
}

function cli(args, options = {}) {
  return dexecMust(['node', cliInContainer, ...args], { timeout: options.timeout ?? 120_000 })
}

function cliJson(name, args) {
  const result = cli(args)
  writeFileSync(join(evidenceDir, name), result.stdout)
  return JSON.parse(result.stdout)
}

function startContainer(base, bun, home, containerUrl) {
  const suffix = base.database.slice('keel_jt01_'.length).replace(/[^a-z0-9_]/g, '')
  containerName = `keel-jt01-fault-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const args = [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--entrypoint',
    'sh',
    '-e',
    'HOME=/tmp/omp-home',
    '-e',
    'PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
    '-e',
    'JT01_RUNNER=native-omp',
    '-e',
    'JT01_OMP_CLI=/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
    '-e',
    `KEEL_DATABASE_URL=${containerUrl}`,
    '-v',
    `${realpathSync(ROOT)}:/src:ro`,
    '-v',
    `${base.fixture}:/workspace:ro`,
    '-v',
    `${home}:/tmp/omp-home:rw`,
    '-v',
    `${base.ompModules}:/opt/node_modules:ro`,
    '-v',
    `${bun.root}:/opt/bun:ro`,
    'node:24-bookworm-slim',
    '/src/scripts/jt01/container-entrypoint.sh',
  ]
  const result = run('docker', args, { timeout: 60_000 })
  assert(result.code === 0, `容器启动失败：${truncate(result.stderr || result.stdout)}`)
  containerId = result.stdout.trim()
  assert(containerId !== '', '容器 ID 为空')
  state.container = {
    name: containerName,
    id: containerId,
    mounts: { src: 'ro', workspace: 'ro', home: 'rw', omp: 'ro', bun: 'ro' },
  }
  step('container-started', { name: containerName, id: containerId })
}

async function waitGateway() {
  await until(
    '容器网关就绪',
    30_000,
    () => {
      const inspect = run('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
        timeout: 5_000,
      })
      if (inspect.code !== 0 || inspect.stdout.trim() !== 'true') fail('容器未运行')
      return (
        run('docker', ['exec', containerName, 'node', '-e', GATEWAY_PROBE], {
          timeout: 5_000,
        }).code === 0
      )
    },
    POLL_MS,
  )
}

function verifyContainer(base, bun) {
  const ompVersion = dexecMust(['omp', '--version']).stdout.trim()
  assert(ompVersion === 'omp/18.11.1', `容器 OMP 版本不是 omp/18.11.1：${ompVersion}`)
  const bunVersion = dexecMust(['bun', '--version']).stdout.trim()
  assert(bunVersion === base.bunVersion, `容器 Bun 版本不一致：${bunVersion} != ${base.bunVersion}`)
  const nodeVersion = dexecMust(['node', '--version']).stdout.trim()
  assert(/^v24\./.test(nodeVersion), `容器 Node 不是 24：${nodeVersion}`)
  const path = dexecMust(['sh', '-c', 'printf %s "$PATH"']).stdout
  assert(path === '/opt/bun/bin:/usr/local/bin:/usr/bin:/bin', `容器 PATH 不符合固定值：${path}`)
  const ompPath = dexecMust(['sh', '-c', 'command -v omp']).stdout.trim()
  assert(ompPath === '/usr/local/bin/omp', `容器 omp 不来自固定入口：${ompPath}`)
  const bunPath = dexecMust(['sh', '-c', 'command -v bun']).stdout.trim()
  assert(bunPath === '/opt/bun/bin/bun', `容器 bun 不来自固定包：${bunPath}`)
  const entrySha256 = dexecMust([
    'node',
    '-e',
    'const fs=require("node:fs");const crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/usr/local/bin/omp")).digest("hex"));',
  ]).stdout.trim()
  assert(
    entrySha256 === base.ompEntrySha256,
    `容器 OMP 入口 SHA256 不一致：${entrySha256} != ${base.ompEntrySha256}`,
  )
  return {
    omp_version: ompVersion,
    bun_version: bunVersion,
    bun_package_version: bun.version,
    node_version: nodeVersion,
    omp_path: ompPath,
    bun_path: bunPath,
    omp_entry_sha256: entrySha256,
    path,
  }
}

async function until(label, timeoutMs, probe, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(intervalMs)
  }
  fail(`${label} 超时（${timeoutMs}ms）`)
}

function contextSections(context) {
  return context && Array.isArray(context.sections) ? context.sections : []
}

function containerWorkerPid(worker) {
  const result = dexec(
    [
      'sh',
      '-c',
      'test -s "$1" || exit 1; p=$(cat "$1") || exit 1; kill -0 "$p" 2>/dev/null || exit 1; printf %s "$p"',
      'sh',
      worker.pidFile,
    ],
    { timeout: 5_000 },
  )
  if (result.code !== 0) return null
  const pid = Number(result.stdout.trim())
  return Number.isInteger(pid) && pid > 1 ? pid : null
}

function startWorker(role, once) {
  const pidFile = `/tmp/jt01-fault-${role}.pid`
  const args = ['managed', 'worker']
  if (once) args.push('--once')
  args.push('--task', taskId, '--harness', 'omp', '--model', MODEL)
  if (!once) args.push('--interval', '250')
  const logPath = join(evidenceDir, `worker-${role}.log`)
  const fd = openSync(logPath, 'a')
  const child = spawn(
    'docker',
    [
      'exec',
      containerName,
      'sh',
      '-c',
      'echo $$ > "$1"; shift; exec node "$@"',
      'sh',
      pidFile,
      cliInContainer,
      ...args,
    ],
    { stdio: ['ignore', fd, fd] },
  )
  closeSync(fd)
  const worker = {
    role,
    pidFile,
    child,
    pid: null,
    attemptId: null,
    model: null,
    exit: null,
    spawn_error: null,
    started_at: now(),
    signal_sent_at: null,
    killed_at: null,
  }
  child.on('error', (error) => {
    worker.spawn_error = error.message
  })
  workers.push(worker)
  step('worker-started', { role, once, pid_file: pidFile })
  return worker
}

async function waitWorkerReady(worker) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (worker.spawn_error !== null) fail(`worker ${worker.role} 启动失败：${worker.spawn_error}`)
    if (worker.child.exitCode !== null || worker.child.signalCode !== null)
      fail(
        `worker ${worker.role} 启动后立即退出（code=${worker.child.exitCode} signal=${worker.child.signalCode}）`,
      )
    const pid = containerWorkerPid(worker)
    if (pid !== null) {
      const probe = dexec(['node', '-e', WORKER_CMDLINE_PROBE, String(pid), cliInContainer], {
        timeout: 5_000,
      })
      if (probe.code === 0) {
        worker.pid = pid
        step('worker-ready', { role: worker.role, pid })
        return worker
      }
    }
    await sleep(100)
  }
  fail(`worker ${worker.role} 未在 15s 内就绪`)
}

function waitWorkerExit(worker, timeoutMs) {
  if (worker.exit !== null) return Promise.resolve(worker.exit)
  const child = worker.child
  if (child.exitCode !== null || child.signalCode !== null) {
    worker.exit = { code: child.exitCode, signal: child.signalCode }
    return Promise.resolve(worker.exit)
  }
  return new Promise((done, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`worker ${worker.role} 退出超时`))
    }, timeoutMs)
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.exit = { code, signal }
      done(worker.exit)
    }
    child.once('exit', finish)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`worker ${worker.role} 进程错误：${error.message}`))
    })
  })
}

function signalWorkerKill(worker) {
  assert(worker.pid !== null, `worker ${worker.role} 没有已确认 pid`)
  const result = dexec(
    [
      'sh',
      '-c',
      'p=$(cat "$1"); test "$p" = "$2" || exit 1; kill -KILL "$p"',
      'sh',
      worker.pidFile,
      String(worker.pid),
    ],
    { timeout: 5_000 },
  )
  assert(result.code === 0, `无法 SIGKILL worker ${worker.role}（pid=${worker.pid}）`)
  worker.signal_sent_at = now()
  worker.killed_at = worker.signal_sent_at
}

async function stopWorker(worker) {
  if (worker.exit !== null || worker.child.exitCode !== null || worker.child.signalCode !== null) {
    await waitWorkerExit(worker, 1_000).catch(() => undefined)
    return
  }
  const pid = containerWorkerPid(worker)
  if (pid !== null) {
    dexec(
      [
        'sh',
        '-c',
        'p=$(cat "$1"); test "$p" = "$2" || exit 1; kill -TERM "$p"',
        'sh',
        worker.pidFile,
        String(pid),
      ],
      { timeout: 5_000 },
    )
  }
  try {
    await waitWorkerExit(worker, 10_000)
    return
  } catch {
    if (pid !== null) {
      dexec(
        [
          'sh',
          '-c',
          'p=$(cat "$1"); test "$p" = "$2" || exit 1; kill -KILL "$p"',
          'sh',
          worker.pidFile,
          String(pid),
        ],
        { timeout: 5_000 },
      )
    }
  }
  await waitWorkerExit(worker, 5_000).catch(() => undefined)
}

function findModelProcesses() {
  const result = dexecMust(['node', '-e', MODEL_SCAN], { timeout: 10_000 })
  const list = JSON.parse(result.stdout)
  assert(Array.isArray(list), '模型进程扫描结果不是数组')
  return list
}

function modelAlive(model) {
  return findModelProcesses().some(
    (item) => item.pid === model.pid && item.starttime === model.starttime,
  )
}

function killModelGroup(model) {
  const result = dexecMust(['node', '-e', MODEL_KILL, String(model.pid), String(model.starttime)], {
    timeout: 10_000,
  })
  return JSON.parse(result.stdout)
}

function collectFaultSnapshot(worker, mode, questionId) {
  const task = dbTask()
  assert(task?.status === 'RUNNING', `故障点任务不是 RUNNING：${task?.status}`)
  const attempt = dbRunningAttempt()
  assert(attempt?.status === 'RUNNING', '故障点没有 RUNNING attempt')
  const sections = contextSections(attempt.context)
  assert(sections.length > 0, '故障点 attempt.context 为空')
  assert(worker.pid !== null && containerWorkerPid(worker) === worker.pid, '故障点 worker 已不在')
  assert(worker.model !== null, '故障点没有已确认的模型进程')
  assert(modelAlive(worker.model), '故障点模型进程已退出')
  const questions = dbQuestions()
  if (mode === 'before-question') {
    assert(questions.length === 0, 'before-question 故障点已出现 managed_question')
  } else {
    assert(questions.length === 1, `after-answer 故障点问题数不是 1：${questions.length}`)
    assert(questions[0].id === questionId, 'after-answer 故障点 question id 变化')
    assert(questions[0].status === 'RESOLVED', 'after-answer 故障点问题不是 RESOLVED')
    assert(questions[0].answer === ANSWER, 'after-answer 故障点答案变化')
  }
  return {
    at: now(),
    task_status: task.status,
    attempt_id: attempt.id,
    phase: attempt.phase,
    lease_token: attempt.lease_token,
    context: {
      context_id: attempt.context.context_id,
      recipe_id: attempt.context.recipe_id,
      section_ids: sections.map((section) => section.id),
      total_tokens: attempt.context.total_tokens,
    },
    worker_pid: worker.pid,
    model_pid: worker.model.pid,
    model_starttime: worker.model.starttime,
    question_count: questions.length,
  }
}

function collectKillCheck(snapshot, mode, questionId) {
  const task = dbTask()
  assert(task?.status === 'RUNNING', `模型已抢先提交：SIGKILL 后任务状态 ${task?.status}`)
  const attempt = dbRunningAttempt()
  assert(attempt?.status === 'RUNNING', '模型已抢先提交：SIGKILL 后没有 RUNNING attempt')
  assert(
    attempt.id === snapshot.attempt_id,
    `模型已抢先提交：SIGKILL 后 attempt ${attempt.id} != ${snapshot.attempt_id}`,
  )
  assert(attempt.lease_token === snapshot.lease_token, 'SIGKILL 后 lease token 变化')
  const questions = dbQuestions()
  if (mode === 'before-question') {
    assert(questions.length === 0, 'SIGKILL 后已出现 managed_question')
  } else {
    assert(questions.length === 1, `SIGKILL 后问题数不是 1：${questions.length}`)
    assert(questions[0].id === questionId, 'SIGKILL 后 question id 变化')
    assert(questions[0].status === 'RESOLVED', 'SIGKILL 后问题不是 RESOLVED')
    assert(questions[0].answer === ANSWER, 'SIGKILL 后答案变化')
  }
  return {
    at: now(),
    task_status: task.status,
    attempt_id: attempt.id,
    phase: attempt.phase,
    lease_token: attempt.lease_token,
    question_count: questions.length,
    question_id: questions[0]?.id ?? null,
    question_status: questions[0]?.status ?? null,
    question_answer: questions[0]?.answer ?? null,
  }
}

async function waitFaultPoint(worker, mode, questionId) {
  return until(
    '故障点',
    STAGE_MS,
    () => {
      if (worker.spawn_error !== null) fail(`worker ${worker.role} 启动失败：${worker.spawn_error}`)
      if (worker.child.exitCode !== null || worker.child.signalCode !== null)
        fail(`worker ${worker.role} 在故障注入前退出`)
      const questions = dbQuestions()
      if (mode === 'before-question' && questions.length > 0)
        fail('worker 在 before-question 故障注入前已创建问题')
      const status = dbStatus()
      if (['DONE', 'FAILED', 'CANCELLED'].includes(status)) fail(`任务在故障注入前进入 ${status}`)
      if (mode === 'after-answer' && status === 'WAITING_HUMAN')
        fail('答复后任务再次等待人工，未进入恢复调查')
      if (status !== 'RUNNING') return null
      const attempt = dbRunningAttempt()
      if (!attempt || contextSections(attempt.context).length === 0) return null
      if (mode === 'after-answer') {
        const question = questions.find((item) => item.id === questionId)
        if (
          questions.length !== 1 ||
          question === undefined ||
          question.status !== 'RESOLVED' ||
          question.answer !== ANSWER
        )
          fail('答复后问题状态或答案不符合预期')
      }
      const models = findModelProcesses()
      if (models.length === 0) return null
      if (models.length > 1) fail(`发现多个模型进程：${models.map((item) => item.pid).join(',')}`)
      worker.model = models[0]
      worker.attemptId = attempt.id
      return { attempt, model: models[0] }
    },
    POLL_MS,
  )
}

async function waitFaultStable(worker, mode, questionId) {
  const first = await waitFaultPoint(worker, mode, questionId)
  await sleep(2_000)
  const snapshot = collectFaultSnapshot(worker, mode, questionId)
  assert(snapshot.attempt_id === first.attempt.id, '2 秒后 attempt id 变化')
  return snapshot
}

async function killFault(worker, snapshot, mode, questionId) {
  signalWorkerKill(worker)
  const modelKill = killModelGroup(worker.model)
  const final = collectKillCheck(snapshot, mode, questionId)
  const exit = await waitWorkerExit(worker, 15_000)
  assert(
    exit.code === 137 || exit.signal === 'SIGKILL',
    `被 kill worker 退出不是 137/SIGKILL：code=${exit.code} signal=${exit.signal}`,
  )
  await sleep(200)
  assert(!modelAlive(worker.model), '已确认模型进程在 SIGKILL 后仍存活')
  const status = cliJson(`status-fault-${mode}.json`, ['managed', 'status', taskId])
  const questions = cliJson(`questions-fault-${mode}.json`, [
    'managed',
    'questions',
    '--task',
    taskId,
  ])
  step('fault-killed', {
    role: worker.role,
    worker_pid: worker.pid,
    model_pid: worker.model.pid,
    worker_exit: exit,
    model_kill: modelKill,
    final_check: final,
    question_count: questions.length,
  })
  return { snapshot, final_check: final, status, model_kill: modelKill, worker_exit: exit }
}

function assertSuggestion(question) {
  assert(question?.suggestion?.unavailable !== true, `问题 ${question?.id} 的天问建议不可用`)
  assert(
    typeof question.suggestion.recommendation === 'string' &&
      question.suggestion.recommendation.trim() !== '',
    `问题 ${question.id} 的天问建议为空`,
  )
}

function loadWaitingQuestion(label) {
  const status = cliJson(`status-${label}.json`, ['managed', 'status', taskId])
  const questions = cliJson(`questions-${label}.json`, ['managed', 'questions', '--task', taskId])
  assert(status.status === 'WAITING_HUMAN', `等待人工状态不是 WAITING_HUMAN：${status.status}`)
  const waiting = questions.filter((question) => question.status === 'WAITING_HUMAN')
  assert(waiting.length === 1, `WAITING_HUMAN 问题数不是 1：${waiting.length}`)
  const question = waiting[0]
  assert(status.pending_question_id === question.id, 'pending_question_id 与等待问题不一致')
  assertSuggestion(question)
  const audit = dbAudit()
  writeFileSync(join(evidenceDir, `audit-${label}.json`), `${JSON.stringify(audit, null, 2)}\n`)
  assert(
    audit.attempts.some(
      (attempt) =>
        attempt.phase === 'tianwen' &&
        attempt.status === 'SUCCEEDED' &&
        attempt.result?.unavailable !== true &&
        typeof attempt.result?.recommendation === 'string' &&
        attempt.result.recommendation.trim() !== '',
    ),
    '没有真实的 SUCCEEDED 天问 attempt',
  )
  assert(
    audit.events.some(
      (event) =>
        event.type === 'TianwenSuggested' &&
        event.payload.questionId === question.id &&
        event.payload.suggestion?.unavailable !== true,
    ),
    '没有 TianwenSuggested 成功事件',
  )
  step('waiting-human', { question_id: question.id, label })
  return question
}

function answerQuestion(questionId, label) {
  const result = cli(['managed', 'answer', questionId, '--text', ANSWER])
  assert(result.stdout.trim() === taskId, `managed answer 返回了意外 task：${result.stdout.trim()}`)
  writeFileSync(join(evidenceDir, `answer-${label}.txt`), `${ANSWER}\n`)
  step('answered', { question_id: questionId, label })
}

async function driveToQuestion() {
  const deadline = Date.now() + STAGE_MS
  let index = 0
  while (Date.now() < deadline) {
    const status = dbStatus()
    if (status === 'WAITING_HUMAN') return
    if (['DONE', 'FAILED', 'CANCELLED'].includes(status))
      fail(`推进到 WAITING_HUMAN 前任务进入 ${status}`)
    if (status === 'READY' || status === 'WAITING_TIANWEN') {
      index++
      const worker = startWorker(`once-${index}`, true)
      await waitWorkerReady(worker)
      let exit
      try {
        exit = await waitWorkerExit(worker, 110_000)
      } catch (error) {
        try {
          signalWorkerKill(worker)
        } catch {}
        throw error
      }
      if (exit.code !== 0) {
        const after = dbStatus()
        assert(
          ['READY', 'WAITING_TIANWEN', 'WAITING_HUMAN'].includes(after),
          `worker 失败且任务状态为 ${after}`,
        )
      }
      continue
    }
    await sleep(POLL_MS)
  }
  fail('推进到 WAITING_HUMAN 超时')
}

async function waitStatus(targets, timeoutMs, label) {
  return until(
    label,
    timeoutMs,
    () => {
      const status = dbStatus()
      if (targets.includes(status)) return status
      if (['FAILED', 'CANCELLED'].includes(status)) fail(`任务进入 ${status}`)
      if (status === 'DONE' && !targets.includes('DONE')) fail('任务提前 DONE')
      if (status === 'WAITING_HUMAN' && !targets.includes('WAITING_HUMAN')) fail('任务再次等待人工')
      return null
    },
    POLL_MS,
  )
}

async function waitLeaseExpired(snapshot) {
  return until(
    'lease 自然过期',
    RECOVERY_MS,
    () => {
      const status = dbStatus()
      if (['FAILED', 'CANCELLED'].includes(status)) fail(`lease 过期前任务进入 ${status}`)
      if (status === 'DONE') fail('lease 过期事件前任务已 DONE')
      return dbLeaseEvent(snapshot.lease_token)
    },
    1_000,
  )
}

async function beforeQuestion() {
  const faultWorker = startWorker('before-question-once', true)
  await waitWorkerReady(faultWorker)
  const snapshot = await waitFaultStable(faultWorker, 'before-question', null)
  step('fault-snapshot', snapshot)
  const kill = await killFault(faultWorker, snapshot, 'before-question', null)
  const resident = startWorker('before-question-recovery', false)
  await waitWorkerReady(resident)
  const lease = await waitLeaseExpired(snapshot)
  step('lease-expired', lease)
  await waitStatus(['WAITING_HUMAN'], RECOVERY_MS, 'before-question-waiting-human')
  const question = loadWaitingQuestion('waiting-human-before')
  answerQuestion(question.id, 'before')
  await waitStatus(['DONE'], RECOVERY_MS, 'before-question-done')
  await stopWorker(resident)
  return { fault_worker: faultWorker, resident, question, snapshot, kill, lease }
}

async function afterAnswer() {
  await driveToQuestion()
  const question = loadWaitingQuestion('waiting-human-after')
  const resident = startWorker('after-answer-resident', false)
  await waitWorkerReady(resident)
  answerQuestion(question.id, 'after')
  const resolved = dbQuestions().find((item) => item.id === question.id)
  assert(resolved?.status === 'RESOLVED', 'CLI 答复后问题不是 RESOLVED')
  assert(resolved.answer === ANSWER, 'CLI 答复后答案不一致')
  const snapshot = await waitFaultStable(resident, 'after-answer', question.id)
  step('fault-snapshot', snapshot)
  const kill = await killFault(resident, snapshot, 'after-answer', question.id)
  const recovery = startWorker('after-answer-recovery', false)
  await waitWorkerReady(recovery)
  const lease = await waitLeaseExpired(snapshot)
  step('lease-expired', lease)
  await waitStatus(['DONE'], RECOVERY_MS, 'after-answer-done')
  await stopWorker(recovery)
  return { resident, recovery, question, snapshot, kill, lease }
}

function validateCitations(report, task, fixture) {
  const observations = Array.isArray(task.observations) ? task.observations : []
  const citations = Array.isArray(report.citations) ? report.citations : []
  assert(citations.length > 0, 'completed report 没有 citations')
  for (const citation of citations) {
    assert(
      typeof citation.path === 'string' && typeof citation.digest === 'string',
      'citation 缺少 path 或 digest',
    )
    const observation = observations.find(
      (item) => item.path === citation.path && item.digest === citation.digest,
    )
    assert(observation !== undefined, `citation 未匹配 observations：${citation.path}`)
    const absolute = resolve(fixture, citation.path)
    assert(inside(absolute, fixture), `citation 路径越出 fixture：${citation.path}`)
    const bytes = readFileSync(absolute)
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert(digest === citation.digest, `fixture 文件 SHA256 与 citation 不一致：${citation.path}`)
    assert(
      observation.content === bytes.toString('utf8'),
      `observation 内容与 fixture 字节不一致：${citation.path}`,
    )
  }
  return citations
}

function validateFinal(base, pointResult, baseline) {
  const audit = dbAudit()
  writeFileSync(join(evidenceDir, 'audit-final.json'), `${JSON.stringify(audit, null, 2)}\n`)
  const status = cliJson('status-final.json', ['managed', 'status', taskId])
  const questions = cliJson('questions-final.json', ['managed', 'questions', '--task', taskId])
  const task = audit.task
  assert(task?.id === taskId, '最终 audit.task 不是本次 task')
  assert(task.repo_id === base.repoId, '最终 task.repo_id 与 base 不一致')
  assert(task.question === QUESTION, '最终 task.question 与 smoke 问题不一致')
  assert(task.status === 'DONE' && status.status === 'DONE', '最终 task 不是 DONE')
  assert(task.pending_question_id === null, '最终 task 仍有 pending_question_id')
  assert(task.report?.outcome === 'completed', '最终 report 不是 completed')
  assert(
    typeof task.report.report === 'string' && task.report.report.trim() !== '',
    '最终 report 为空',
  )
  assert(status.report?.outcome === 'completed', 'CLI 最终 report 不是 completed')
  const citations = validateCitations(task.report, task, base.fixture)
  assert(
    audit.events.some((event) => event.type === 'ManagedInvestigationCompleted'),
    '缺少 ManagedInvestigationCompleted 事件',
  )

  const questionId = pointResult.question.id
  assert(audit.questions.length === 1, `最终问题数不是 1：${audit.questions.length}`)
  const question = audit.questions[0]
  assert(question.id === questionId, '最终 question id 变化')
  assert(question.status === 'RESOLVED', '最终问题不是 RESOLVED')
  assert(question.answer === ANSWER, '最终问题答案变化')
  assertSuggestion(question)
  const tianwenAttempts = audit.attempts.filter(
    (attempt) =>
      attempt.phase === 'tianwen' &&
      attempt.status === 'SUCCEEDED' &&
      attempt.result?.unavailable !== true &&
      typeof attempt.result?.recommendation === 'string' &&
      attempt.result.recommendation.trim() !== '',
  )
  assert(tianwenAttempts.length >= audit.questions.length, '天问 SUCCEEDED attempt 少于问题数')
  for (const item of audit.questions) {
    assertSuggestion(item)
    assert(
      audit.events.some(
        (event) =>
          event.type === 'TianwenSuggested' &&
          event.payload.questionId === item.id &&
          event.payload.suggestion?.unavailable !== true,
      ),
      `问题 ${item.id} 没有成功的 TianwenSuggested 事件`,
    )
  }

  const humanEvents = audit.events.filter((event) => event.type === 'ManagedHumanAnswered')
  assert(humanEvents.length === 1, `ManagedHumanAnswered 不是一次：${humanEvents.length}`)
  assert(humanEvents[0].payload.questionId === questionId, '人工答复 question id 不一致')
  assert(humanEvents[0].payload.answer === ANSWER, '人工答复内容不一致')
  assert(Array.isArray(task.answers) && task.answers.length === 1, 'task.answers 不是一次')
  assert(task.answers[0].actor === 'human', 'task.answers actor 不是 human')
  assert(task.answers[0].answer === ANSWER, 'task.answers 内容不一致')
  assert(Array.isArray(questions) && questions.length === 1, 'CLI 最终问题数不是 1')

  const killed = audit.attempts.find((attempt) => attempt.id === pointResult.snapshot.attempt_id)
  assert(killed !== undefined, '找不到被 kill 的 attempt')
  assert(killed.phase === 'investigate', '被 kill 的 attempt 不是 investigate')
  assert(killed.status === 'TIMEOUT', `被 kill attempt 不是 TIMEOUT：${killed.status}`)
  assert(killed.error === 'owner lease expired', `被 kill attempt error 不符：${killed.error}`)
  assert(
    killed.lease_token === pointResult.snapshot.lease_token,
    '被 kill attempt lease token 变化',
  )
  const leaseEvents = audit.events.filter((event) => event.type === 'ManagedLeaseExpired')
  assert(leaseEvents.length >= 1, '没有 ManagedLeaseExpired 事件')
  assert(
    leaseEvents.some((event) => event.payload.token === pointResult.snapshot.lease_token),
    'ManagedLeaseExpired 未对应被 kill 的 lease',
  )
  assert(
    pointResult.lease.payload.token === pointResult.snapshot.lease_token,
    '记录的 lease 事件与故障 lease 不一致',
  )

  const ordered = [...audit.attempts].sort(
    (left, right) =>
      Date.parse(left.started_at) - Date.parse(right.started_at) || left.id.localeCompare(right.id),
  )
  const faultIndex = ordered.findIndex((attempt) => attempt.id === killed.id)
  assert(faultIndex >= 0, '恢复前后 attempt 排序失败')
  const resumed = ordered.slice(faultIndex + 1).find((attempt) => attempt.phase === 'investigate')
  assert(resumed !== undefined, '没有恢复后的 investigate attempt')
  assert(resumed.id !== killed.id, '恢复后 attempt 与被 kill attempt 相同')

  const beforeIds = baseline.ids
  const afterIds = dbTaskIds()
  const newIds = afterIds.filter((id) => !beforeIds.includes(id))
  assert(newIds.length === 1 && newIds[0] === taskId, `新增 task 不是唯一一个：${newIds.join(',')}`)
  const afterOld = psqlJson(taskSnapshotSql(taskId))
  assert(
    JSON.stringify(afterOld) === JSON.stringify(baseline.tasks),
    '旧 task 在故障验收期间被修改',
  )

  const usageAttempts = audit.attempts.map((attempt) => ({
    id: attempt.id,
    phase: attempt.phase,
    status: attempt.status,
    usage: attempt.usage ?? null,
  }))
  const usageObserved = usageAttempts.some((item) => {
    const usage = item.usage ?? {}
    return (
      (usage.tokens_in !== null && usage.tokens_in !== undefined) ||
      (usage.tokens_out !== null && usage.tokens_out !== undefined) ||
      (usage.cost_usd !== null && usage.cost_usd !== undefined)
    )
  })
  const fixtureFiles = ['README.md', 'release-choice.md'].map((name) => ({
    path: name,
    sha256: sha256File(join(base.fixture, name)),
  }))
  const runtime = {
    model: MODEL,
    thinking: base.thinking,
    omp_version: base.ompVersion,
    omp_package_version: base.ompPackageVersion,
    omp_package_entry_sha256: base.ompEntrySha256,
    bun_version: base.bunVersion,
    bun_package_version: base.bunPackageVersion,
    node_version: state.container_runtime?.node_version,
    path: state.container_runtime?.path,
  }
  state.fixture = { dir: base.fixture, files: fixtureFiles }
  state.runtime = runtime
  state.events = audit.events
  state.attempts = audit.attempts
  state.questions = audit.questions
  state.final_task = { id: task.id, status: task.status, report: task.report }
  state.citations_validated = true
  state.human_answer_count = humanEvents.length
  state.killed_attempt = killed
  state.lease_expired = pointResult.lease
  state.resumed_attempt = resumed
  state.recovery = {
    fault_attempt_id: killed.id,
    resumed_attempt_id: resumed.id,
    fault_lease_token: killed.lease_token,
    lease_expired_event: pointResult.lease,
    task_id_before: taskId,
    task_id_after: task.id,
    question_id_before: questionId,
    question_id_after: question.id,
    answer_before: ANSWER,
    answer_after: question.answer,
  }
  state.usage = {
    status: usageObserved ? 'observed' : 'unknown',
    attempts: usageAttempts,
    note: usageObserved
      ? '仅记录 harness 上报的 usage，未核对实际账单'
      : '未见到真实 usage，保持 null，不补 0',
  }
  state.billing_cost_verified = false
  state.billing_note =
    '仅验证真实 token 用量；静态费用 0 是占位配置，实际账单未知，不能声称 0 费用。'
  state.old_tasks_unchanged = true
  state.new_task_ids = newIds
  state.old_task_snapshot_sha256 = baseline.sha256
  state.citations = citations
  step('final-validated', { task_id: taskId, question_id: questionId })
}

async function prepare(cfg) {
  for (const tool of ['docker', 'node', 'psql'])
    assert(run('sh', ['-c', `command -v ${tool}`]).code === 0, `缺少命令：${tool}`)
  assert(Number(process.versions.node.split('.')[0]) === 24, '需要 Node 24')
  assert(
    run('docker', ['image', 'inspect', 'node:24-bookworm-slim'], { timeout: 30_000 }).code === 0,
    '本机未缓存 node:24-bookworm-slim',
  )
  for (const tool of [
    join(ROOT, 'scripts/jt01/omp-home.mjs'),
    join(ROOT, 'scripts/jt01/container-entrypoint.sh'),
  ])
    assert(statSync(tool).isFile(), `缺少工具脚本：${tool}`)
  assert(
    isExecutable(join(ROOT, 'scripts/jt01/container-entrypoint.sh')),
    'container-entrypoint.sh 不可执行',
  )

  const base = loadBase(cfg.evidence)
  const bun = loadBun(cfg.bunPackage, base)
  const db = prepareDatabase(base)
  const root = realpathSync(ROOT)
  const home = join(evidenceDir, 'omp-home')
  mustRun('node', [join(root, 'scripts/jt01/omp-home.mjs'), home], { timeout: 30_000 })
  const rel = relative(root, base.evidenceDir)
  assert(
    rel !== '' && !rel.startsWith('..') && !isAbsolute(rel),
    'base evidence_dir 无法映射到 /src',
  )
  const relPosix = rel.split(sep).join('/')
  cliInContainer = `/src/${relPosix}/runtime/cli/index.js`
  const packageInContainer = `/src/${relPosix}/jstack-package.json`
  const baselineTasks = psqlJson(taskSnapshotSql())
  const baselineIds = dbTaskIds()
  assert(Array.isArray(baselineTasks), 'baseline task 快照不是数组')
  assert(Array.isArray(baselineIds), 'baseline task id 不是数组')
  const baseline = {
    tasks: baselineTasks,
    ids: baselineIds,
    sha256: createHash('sha256').update(JSON.stringify(baselineTasks)).digest('hex'),
  }
  state.base = {
    evidence_file: base.evidenceFile,
    evidence_dir: base.evidenceDir,
    database: base.database,
    harness_kind: base.harnessKind,
    harness_version: base.harnessVersion,
    omp_version: base.ompVersion,
    bun_version: base.bunVersion,
    task_id: base.taskId,
    question_id: base.questionId,
    repo_id: base.repoId,
    runtime: base.runtime,
  }
  state.database = {
    name: base.database,
    host: 'localhost',
    port: 5432,
    current_database: base.database,
  }
  state.baseline = {
    task_count: baselineIds.length,
    task_ids: baselineIds,
    tasks_sha256: baseline.sha256,
  }
  state.fixture = { dir: base.fixture, files: [] }

  startContainer(base, bun, home, db.containerUrl)
  await waitGateway()
  state.container_runtime = verifyContainer(base, bun)
  step('container-verified', state.container_runtime)

  const created = cli([
    'managed',
    'investigate',
    '--repo',
    base.repoId,
    '--question',
    QUESTION,
    '--package',
    packageInContainer,
  ])
  taskId = created.stdout.trim()
  assert(UUID.test(taskId), `managed investigate 返回非法 task id：${taskId}`)
  state.task_id = taskId
  const task = dbTask()
  assert(task?.repo_id === base.repoId, '新 task repo_id 与 base 不一致')
  assert(task?.question === QUESTION, '新 task question 与 smoke 不一致')
  writeFileSync(join(evidenceDir, 'status-initial.json'), `${JSON.stringify(task, null, 2)}\n`)
  step('task-created', { task_id: taskId })
  return { base, bun, db, home, root, baseline, packageInContainer }
}

async function entry() {
  try {
    const cfg = parseArgs(process.argv.slice(2))
    state = { ok: false, point: cfg.point, started_at: now(), steps: [], workers: [] }
    mkdirSync(join(ROOT, '.keel'), { recursive: true })
    evidenceDir = mkdtempSync(join(ROOT, '.keel', 'jt01-fault.'))
    state.fault_evidence_dir = evidenceDir
    writeState()
    const ctx = await prepare(cfg)
    const pointResult =
      cfg.point === 'before-question' ? await beforeQuestion() : await afterAnswer()
    validateFinal(ctx.base, pointResult, ctx.baseline)
    state.point_result = {
      question_id: pointResult.question.id,
      fault_worker_pid: pointResult.snapshot.worker_pid,
      fault_model_pid: pointResult.snapshot.model_pid,
      fault_attempt_id: pointResult.snapshot.attempt_id,
      worker_exit: pointResult.kill.worker_exit,
      model_kill: pointResult.kill.model_kill,
      lease_expired: pointResult.lease,
    }
    state.ok = true
    state.finished_at = now()
    step('complete', { task_id: taskId, point: cfg.point })
    console.log(`jt01-fault: 成功 task=${taskId} point=${cfg.point}`)
  } catch (error) {
    state.ok = false
    state.error = error instanceof Error ? error.message : String(error)
    state.failed_at = now()
    if (containerName !== null && evidenceDir !== null) {
      const logs = run('docker', ['logs', containerName], { timeout: 10_000 })
      writeFileSync(join(evidenceDir, 'container.log'), `${logs.stdout}${logs.stderr}`)
    }
    if (taskId !== null && evidenceDir !== null) {
      try {
        const audit = dbAudit()
        state.partial_audit = audit
        writeFileSync(
          join(evidenceDir, 'audit-partial.json'),
          `${JSON.stringify(audit, null, 2)}\n`,
        )
      } catch {}
    }
    console.error(`jt01-fault: ${state.error}`)
    process.exitCode = 1
  } finally {
    for (const worker of workers) {
      try {
        await stopWorker(worker)
      } catch {}
    }
    if (containerName !== null) {
      const stopped = run('docker', ['stop', '--time', '5', containerName], { timeout: 20_000 })
      state.container_stop = { code: stopped.code, stderr: truncate(stopped.stderr) }
    }
    try {
      writeState()
    } catch (error) {
      console.error(
        `jt01-fault: 写证据失败：${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
    }
    if (evidenceDir !== null) console.log(`fault-evidence: ${evidenceDir}`)
  }
}

entry()
