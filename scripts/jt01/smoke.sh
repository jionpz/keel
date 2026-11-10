#!/bin/sh
set -eu
umask 077

MODEL='opencode-go/deepseek-v4.1-flash'
ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
EVIDENCE=
CONTAINER=
RECOVERY_EXEC_PID=

usage() {
  cat <<'EOF'
JT-01 runner 烟测（Pi 兼容 / 原生 OMP）。

用法：
  sh scripts/jt01/smoke.sh --runner pi-compat --package <jstack导出的json文件> --pi-package <固定副本的Pi package绝对目录>
  sh scripts/jt01/smoke.sh --runner native-omp --package <jstack导出的json文件> --omp-node-modules <固定副本的node_modules绝对目录> --bun-package <固定副本的Bun package绝对目录>

执行：
  真实 jstack 调查包 → managed investigate → 天问建议 → 测试操作者选择 A灯塔 →
  全新常驻 worker 自动恢复 → 带 path/digest 的 completed 报告。

--runner：
  默认 pi-compat。native-omp 直接调用固定副本中的真实 OMP CLI，不经过 Pi 兼容 wrapper。

--pi-package：
  必须传固定副本的绝对目录，不要指向宿主 npm 正在安装或升级的目录。
  宿主 npm 替换包目录会让运行中的 bind mount 消失。
  脚本不安装、更新或删除 Pi package。

--omp-node-modules：
  native-omp 使用的固定 node_modules 绝对目录，须包含 @oh-my-pi/pi-coding-agent。

--bun-package：
  native-omp 使用的固定 Bun package 绝对目录，须包含 bin/bun。

边界：
  pi-compat 是 Pi 兼容 runner 烟测，不能关闭原生 OMP/Claude 支持验收。
  native-omp 是真实 OMP runner 烟测，不包含故障注入或 SIGKILL 验收。

runner 与参数不可混用；缺值、重复或未知参数一律拒绝。脚本只停止自己启动的容器，保留数据库、夹具和日志。
EOF
}

fail() {
  printf 'jt01-smoke: %s\n' "$*" >&2
  [ -z "$EVIDENCE" ] || printf 'evidence: %s\n' "$EVIDENCE" >&2
  exit 1
}

field() {
  node -e 'const fs=require("node:fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=o[process.argv[2]];if(v===undefined||v===null)process.exit(1);process.stdout.write(String(v))' "$1" "$2" \
    || fail "读取 JSON 字段失败：$1"
}

sha256_file() {
  node -e 'const fs=require("node:fs");const crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

stop_recovery() {
  [ -n "$RECOVERY_EXEC_PID" ] || return 0
  docker exec "$CONTAINER" sh -c 'test -s /tmp/recovery.pid && kill -TERM "$(cat /tmp/recovery.pid)"' >/dev/null 2>&1 || true
  wait "$RECOVERY_EXEC_PID" 2>/dev/null || true
  RECOVERY_EXEC_PID=
}

cleanup() {
  stop_recovery
  [ -z "$CONTAINER" ] || docker stop "$CONTAINER" >/dev/null 2>&1 || true
}

cli() {
  docker exec "$CONTAINER" node "$CLI_IN_CONTAINER" "$@"
}

save_status() {
  cli managed status "$TASK" > "$EVIDENCE/$1" || fail "managed status 失败：$1"
  field "$EVIDENCE/$1" status
}

audit() {
  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -Atc "SELECT json_build_object('events',(SELECT coalesce(json_agg(json_build_object('seq',e.seq,'type',e.type,'payload',e.payload,'occurred_at',e.occurred_at) ORDER BY e.seq),'[]'::json) FROM managed_event e WHERE e.task_id='$TASK'::uuid),'attempts',(SELECT coalesce(json_agg(json_build_object('id',a.id,'task_id',a.task_id,'phase',a.phase,'status',a.status,'result',a.result,'usage',a.usage,'error',a.error,'started_at',a.started_at,'ended_at',a.ended_at) ORDER BY a.started_at,a.id),'[]'::json) FROM managed_attempt a WHERE a.task_id='$TASK'::uuid))" > "$1" \
    || fail "审计查询失败：$1"
}

start_recovery() {
  docker exec "$CONTAINER" sh -c 'echo $$ > /tmp/recovery.pid; exec node "$1" managed worker --task "$2" --harness omp --model "$3" --interval 250' sh "$CLI_IN_CONTAINER" "$TASK" "$MODEL" > "$EVIDENCE/recovery-worker.log" 2>&1 &
  RECOVERY_EXEC_PID=$!
  i=0
  while [ "$i" -lt 20 ]; do
    if kill -0 "$RECOVERY_EXEC_PID" 2>/dev/null && docker exec "$CONTAINER" sh -c 'test -s /tmp/recovery.pid && kill -0 "$(cat /tmp/recovery.pid)"' >/dev/null 2>&1; then
      return 0
    fi
    i=$((i+1))
    sleep 0.25
  done
  return 1
}

if [ "$#" -eq 1 ]; then
  case "$1" in
    --help|-h) usage; exit 0 ;;
  esac
fi

RUNNER=
PACKAGE=
PI_PACKAGE=
OMP_NODE_MODULES=
BUN_PACKAGE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runner)
      [ "$#" -ge 2 ] || fail '--runner 缺少值'
      [ -z "$RUNNER" ] || fail '--runner 重复'
      case "$2" in
        pi-compat|native-omp) ;;
        *) fail "不支持的 --runner：$2" ;;
      esac
      RUNNER=$2
      shift 2
      ;;
    --package)
      [ "$#" -ge 2 ] || fail '--package 缺少值'
      [ -z "$PACKAGE" ] || fail '--package 重复'
      PACKAGE=$2
      shift 2
      ;;
    --pi-package)
      [ "$#" -ge 2 ] || fail '--pi-package 缺少值'
      [ -z "$PI_PACKAGE" ] || fail '--pi-package 重复'
      PI_PACKAGE=$2
      shift 2
      ;;
    --omp-node-modules)
      [ "$#" -ge 2 ] || fail '--omp-node-modules 缺少值'
      [ -z "$OMP_NODE_MODULES" ] || fail '--omp-node-modules 重复'
      OMP_NODE_MODULES=$2
      shift 2
      ;;
    --bun-package)
      [ "$#" -ge 2 ] || fail '--bun-package 缺少值'
      [ -z "$BUN_PACKAGE" ] || fail '--bun-package 重复'
      BUN_PACKAGE=$2
      shift 2
      ;;
    *)
      fail "不支持的参数：$1"
      ;;
  esac
done
[ -n "$PACKAGE" ] || fail '缺少 --package'
case "$PACKAGE" in /*) ;; *) fail '--package 必须是绝对路径' ;; esac
[ -f "$PACKAGE" ] || fail "找不到调查包：$PACKAGE"
RUNNER=${RUNNER:-pi-compat}
case "$RUNNER" in
  pi-compat)
    [ -n "$PI_PACKAGE" ] || fail 'pi-compat 缺少 --pi-package'
    [ -z "$OMP_NODE_MODULES" ] || fail 'pi-compat 不接受 --omp-node-modules'
    [ -z "$BUN_PACKAGE" ] || fail 'pi-compat 不接受 --bun-package'
    case "$PI_PACKAGE" in /*) ;; *) fail '--pi-package 必须是绝对路径' ;; esac
    PI_PACKAGE=${PI_PACKAGE%/}
    [ -n "$PI_PACKAGE" ] || fail '--pi-package 不能是根目录'
    [ -d "$PI_PACKAGE" ] || fail "找不到 Pi package：$PI_PACKAGE"
    PI_ENTRY="$PI_PACKAGE/dist/bundle/cli.js"
    [ -f "$PI_ENTRY" ] || fail "Pi package 缺少 dist/bundle/cli.js：$PI_PACKAGE"
    ;;
  native-omp)
    [ -z "$PI_PACKAGE" ] || fail 'native-omp 不接受 --pi-package'
    [ -n "$OMP_NODE_MODULES" ] || fail 'native-omp 缺少 --omp-node-modules'
    [ -n "$BUN_PACKAGE" ] || fail 'native-omp 缺少 --bun-package'
    case "$OMP_NODE_MODULES" in /*) ;; *) fail '--omp-node-modules 必须是绝对路径' ;; esac
    case "$BUN_PACKAGE" in /*) ;; *) fail '--bun-package 必须是绝对路径' ;; esac
    OMP_NODE_MODULES=${OMP_NODE_MODULES%/}
    BUN_PACKAGE=${BUN_PACKAGE%/}
    [ -n "$OMP_NODE_MODULES" ] || fail '--omp-node-modules 不能是根目录'
    [ -n "$BUN_PACKAGE" ] || fail '--bun-package 不能是根目录'
    [ -d "$OMP_NODE_MODULES" ] || fail "找不到 OMP node_modules：$OMP_NODE_MODULES"
    [ -d "$BUN_PACKAGE" ] || fail "找不到 Bun package：$BUN_PACKAGE"
    OMP_PACKAGE="$OMP_NODE_MODULES/@oh-my-pi/pi-coding-agent"
    OMP_ENTRY="$OMP_PACKAGE/dist/cli.js"
    [ -f "$OMP_PACKAGE/package.json" ] || fail "OMP package 缺少 package.json：$OMP_PACKAGE"
    [ -f "$OMP_ENTRY" ] || fail "OMP package 缺少 dist/cli.js：$OMP_PACKAGE"
    [ -x "$OMP_ENTRY" ] || fail "OMP package 入口不可执行：$OMP_ENTRY"
    [ -x "$BUN_PACKAGE/bin/bun" ] || fail "Bun package 缺少可执行的 bin/bun：$BUN_PACKAGE"
    ;;
  *)
    fail "不支持的 --runner：$RUNNER"
    ;;
esac

for tool in docker node pnpm psql createdb; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少命令：$tool"
done
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || fail '需要 Node 24'
if [ "$RUNNER" = pi-compat ]; then
  PI_ENTRY_SHA256=$(sha256_file "$PI_ENTRY") || fail '计算 Pi 包入口 SHA256 失败'
else
  OMP_ENTRY_SHA256=$(sha256_file "$OMP_ENTRY") || fail '计算 OMP 包入口 SHA256 失败'
  OMP_PACKAGE_VERSION=$(field "$OMP_PACKAGE/package.json" version) || fail '读取 OMP package 版本失败'
  BUN_PACKAGE_VERSION=$(field "$BUN_PACKAGE/package.json" version) || fail '读取 Bun package 版本失败'
  [ "$OMP_PACKAGE_VERSION" = 18.11.1 ] || fail "OMP package 版本必须是 18.11.1，实际 $OMP_PACKAGE_VERSION"
fi
docker image inspect node:24-bookworm-slim >/dev/null 2>&1 || fail '本机未缓存 node:24-bookworm-slim'

for tool in "$ROOT/scripts/jt01/omp" "$ROOT/scripts/jt01/container-entrypoint.sh"; do
  [ -x "$tool" ] || fail "工具脚本不可执行，请先 chmod +x：$tool"
done
if [ "$RUNNER" = pi-compat ]; then
  [ -f "$ROOT/scripts/jt01/pi-home.mjs" ] || fail '缺少 scripts/jt01/pi-home.mjs'
else
  [ -f "$ROOT/scripts/jt01/omp-home.mjs" ] || fail '缺少 scripts/jt01/omp-home.mjs'
fi

[ -d "$ROOT/.keel" ] || mkdir -p "$ROOT/.keel"
EVIDENCE=$(mktemp -d "$ROOT/.keel/jt01-smoke.XXXXXXXX") || fail '无法创建证据目录'
REL=${EVIDENCE#"$ROOT"/}
FIXTURE="$EVIDENCE/fixture"
mkdir -p "$FIXTURE"
cp "$PACKAGE" "$EVIDENCE/jstack-package.json"

cat > "$FIXTURE/README.md" <<'EOF'
# JT-01 只读调查夹具

## 启动

本夹具没有构建步骤和常驻服务。验证启动条件的真实命令是：

    sh -c 'test -r README.md && test -r release-choice.md && echo fixture-ready'

输出 `fixture-ready` 表示夹具文件齐全，可以接受只读调查。只读调查本身不会执行该命令。

## 内容

- `README.md`：启动说明。
- `release-choice.md`：尚未决定的展示名称偏好。
EOF

cat > "$FIXTURE/release-choice.md" <<'EOF'
# 展示名称偏好

当前有两个都合法、互斥的候选展示名称：

- `A灯塔`
- `B海风`

## 决定状态

尚未决定。测试操作者没有选择 `A灯塔` 或 `B海风`，文件里也没有默认值。需要这个偏好时必须询问测试操作者，并说明两个候选都合法；不要替操作者假定。
EOF

PGROLE=$(psql postgres://localhost:5432/postgres -Atc 'select current_user') || fail '无法连接 Postgres'
case "$PGROLE" in
  ''|*[!A-Za-z0-9_.-]*) fail "当前 Postgres 角色无法安全写入 URL：$PGROLE" ;;
esac
DB="keel_jt01_$(node -p 'crypto.randomUUID().replace(/-/g,"").slice(0,12)')"
EXISTS=$(psql postgres://localhost:5432/postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DB'") || fail '无法检查目标数据库'
[ -z "$EXISTS" ] || fail "数据库已存在：$DB"
createdb --host=localhost --port=5432 "$DB" || fail "创建数据库失败：$DB"
OWNER_URL="postgres://localhost:5432/$DB"
CONTAINER_DB_URL="postgres://$PGROLE@host.docker.internal:5432/$DB"

( cd "$ROOT" && DATABASE_URL="$OWNER_URL" pnpm exec node-pg-migrate up ) > "$EVIDENCE/migrate.log" 2>&1 \
  || fail '数据库迁移失败（见 migrate.log）'
( cd "$ROOT" && pnpm exec tsc -p tsconfig.build.json --outDir "$EVIDENCE/runtime" --declaration false --declarationMap false --sourceMap false ) > "$EVIDENCE/tsc.log" 2>&1 \
  || fail 'TypeScript 构建失败（见 tsc.log）'
[ -f "$EVIDENCE/runtime/cli/index.js" ] || fail '构建产物缺少 runtime/cli/index.js'

REPO_ID=$(node -p 'crypto.randomUUID()')
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -Atc "INSERT INTO repo (id,provider,remote_url,default_branch,local_path,issue_label) VALUES ('$REPO_ID','local','file:///workspace','main','/workspace','jt01')" >/dev/null \
  || fail '绑定 /workspace 的测试 repo 失败'
if [ "$RUNNER" = pi-compat ]; then
  HOME_DIR="$EVIDENCE/pi-home"
  node "$ROOT/scripts/jt01/pi-home.mjs" "$HOME_DIR" >/dev/null || fail '生成最小 Pi home 失败'
else
  HOME_DIR="$EVIDENCE/omp-home"
  node "$ROOT/scripts/jt01/omp-home.mjs" "$HOME_DIR" >/dev/null || fail '生成最小 OMP home 失败'
fi

CLI_IN_CONTAINER="/src/$REL/runtime/cli/index.js"
QUESTION='请阅读 README.md 与 release-choice.md，说明这个夹具如何启动；在 release-choice.md 的展示名称偏好上，必须先询问测试操作者选择 A灯塔 还是 B海风，并结合两个文件说明依据。不要自行假定偏好；需要该决定时使用 waiting_decision。'

CONTAINER_NAME="keel-jt01-${DB#keel_jt01_}"
trap cleanup EXIT
trap 'exit 1' INT TERM
if [ "$RUNNER" = pi-compat ]; then
  CONTAINER_ID=$(docker run -d --rm --name "$CONTAINER_NAME" --entrypoint sh \
    -e HOME=/tmp/pi-home \
    -e PATH=/src/scripts/jt01:/usr/local/bin:/usr/bin:/bin \
    -e JT01_RUNNER=pi-compat \
    -e KEEL_DATABASE_URL="$CONTAINER_DB_URL" \
    -v "$ROOT:/src:ro" \
    -v "$FIXTURE:/workspace:ro" \
    -v "$HOME_DIR:/tmp/pi-home:rw" \
    -v "$PI_PACKAGE:/opt/pi:ro" \
    node:24-bookworm-slim /src/scripts/jt01/container-entrypoint.sh) \
    || fail '容器启动失败'
else
  CONTAINER_ID=$(docker run -d --rm --name "$CONTAINER_NAME" --entrypoint sh \
    -e HOME=/tmp/omp-home \
    -e PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin \
    -e JT01_RUNNER=native-omp \
    -e JT01_OMP_CLI=/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js \
    -e KEEL_DATABASE_URL="$CONTAINER_DB_URL" \
    -v "$ROOT:/src:ro" \
    -v "$FIXTURE:/workspace:ro" \
    -v "$HOME_DIR:/tmp/omp-home:rw" \
    -v "$OMP_NODE_MODULES:/opt/node_modules:ro" \
    -v "$BUN_PACKAGE:/opt/bun:ro" \
    node:24-bookworm-slim /src/scripts/jt01/container-entrypoint.sh) \
    || fail '容器启动失败'
fi
CONTAINER=$CONTAINER_ID
[ -n "$CONTAINER" ] || fail '容器 ID 为空'
printf '%s\n' "$CONTAINER" > "$EVIDENCE/container.id"

i=0
while [ "$i" -lt 30 ]; do
  if docker exec "$CONTAINER" node -e '
const net = require("node:net")
const socket = net.connect(3425, "127.0.0.1")
const timer = setTimeout(() => {
  socket.destroy()
  process.exit(1)
}, 1000)
socket.on("connect", () => {
  clearTimeout(timer)
  socket.end()
  process.exit(0)
})
socket.on("error", () => {
  clearTimeout(timer)
  process.exit(1)
})
' >/dev/null 2>&1; then break; fi
  i=$((i+1))
  sleep 0.5
done
[ "$i" -lt 30 ] || { docker logs "$CONTAINER" > "$EVIDENCE/container.log" 2>&1 || true; fail '网关未就绪（见 container.log）'; }

NODE_VERSION=$(docker exec "$CONTAINER" node --version) || fail '读取容器 Node 版本失败'
HARNESS_VERSION=$(docker exec "$CONTAINER" omp --version) || fail '读取 runner 版本失败'
[ -n "$NODE_VERSION" ] || fail '容器 Node 版本为空'
[ -n "$HARNESS_VERSION" ] || fail 'runner 版本为空'
OMP_VERSION=
BUN_VERSION=
if [ "$RUNNER" = native-omp ]; then
  [ "$HARNESS_VERSION" = 'omp/18.11.1' ] || fail "native-omp 版本必须是 omp/18.11.1，实际 $HARNESS_VERSION"
  OMP_VERSION=$HARNESS_VERSION
  BUN_VERSION=$(docker exec "$CONTAINER" bun --version) || fail '读取 Bun 版本失败'
  [ -n "$BUN_VERSION" ] || fail 'Bun 版本为空'
  [ "$BUN_VERSION" = "$BUN_PACKAGE_VERSION" ] || fail "Bun 运行版本与 package 不一致：$BUN_VERSION != $BUN_PACKAGE_VERSION"
else
  PI_VERSION=$HARNESS_VERSION
fi

TASK=$(cli managed investigate --repo "$REPO_ID" --question "$QUESTION" --package "/src/$REL/jstack-package.json") \
  || fail 'managed investigate 失败'
case "$TASK" in
  *[!0-9a-f-]*|'') fail "非法 task id：$TASK" ;;
esac
[ "${#TASK}" -eq 36 ] || fail "非法 task id：$TASK"

STATUS=$(save_status status-initial.json)
i=0
while [ "$i" -lt 6 ]; do
  case "$STATUS" in WAITING_HUMAN|FAILED|DONE|CANCELLED) break ;; esac
  i=$((i+1))
  if cli managed worker --once --task "$TASK" --harness omp --model "$MODEL" > "$EVIDENCE/worker-$i.json" 2> "$EVIDENCE/worker-$i.err"; then
    STATUS=$(save_status "status-$i.json")
  else
    STATUS=$(save_status "status-$i.json")
    case "$STATUS" in READY|WAITING_TIANWEN) ;; *) fail "worker 失败（status=$STATUS；见 worker-$i.err）" ;; esac
  fi
done
[ "$i" -gt 0 ] || fail 'worker 未执行'
[ "$STATUS" = WAITING_HUMAN ] || fail "未进入 WAITING_HUMAN（实际 $STATUS）"

STATUS=$(save_status status-pre-answer.json)
[ "$STATUS" = WAITING_HUMAN ] || fail "答复前任务不是 WAITING_HUMAN（实际 $STATUS）"
start_recovery || fail '常驻 worker 未启动（见 recovery-worker.log）'
cli managed questions --task "$TASK" > "$EVIDENCE/questions.json" || fail 'managed questions 失败'
QID=$(node -e '
const fs=require("node:fs");
const [sf,qf]=process.argv.slice(1);
const s=JSON.parse(fs.readFileSync(sf,"utf8"));
const qs=JSON.parse(fs.readFileSync(qf,"utf8"));
const waiting=qs.filter(q=>q.status==="WAITING_HUMAN");
const q=waiting[0];
const ok=waiting.length===1&&s.status==="WAITING_HUMAN"&&s.pending_question_id===q.id&&Array.isArray(q.options)&&q.options.length>=2&&q.suggestion&&q.suggestion.unavailable!==true&&typeof q.suggestion.recommendation==="string"&&q.suggestion.recommendation.trim();
if(!ok){console.error("expected one WAITING_HUMAN question with successful Tianwen suggestion");process.exit(1)}
process.stdout.write(q.id)
' "$EVIDENCE/status-pre-answer.json" "$EVIDENCE/questions.json") \
  || fail '待人工问题或天问建议校验失败（见 questions.json）'

audit "$EVIDENCE/audit-pre-answer.json"
node -e '
const fs=require("node:fs");
const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const attempts=Array.isArray(a.attempts)?a.attempts:[];
const events=Array.isArray(a.events)?a.events:[];
const ok=attempts.some(x=>x.phase==="tianwen"&&x.status==="SUCCEEDED"&&x.result&&typeof x.result.recommendation==="string"&&x.result.recommendation.trim());
if(!ok||!events.some(e=>e.type==="TianwenSuggested")){console.error("Tianwen attempt is not a successful suggestion");process.exit(1)}
' "$EVIDENCE/audit-pre-answer.json" || fail '天问 attempt 不是 SUCCEEDED 或无建议'

cli managed answer "$QID" --text '测试操作者决定：选择A灯塔' > "$EVIDENCE/answer.txt" || fail 'managed answer 失败'

STATUS=
i=0
while [ "$i" -lt 150 ]; do
  STATUS=$(save_status status-recovery.json)
  case "$STATUS" in DONE|FAILED|WAITING_HUMAN) break ;; esac
  i=$((i+1))
  sleep 1
done
case "$STATUS" in DONE|FAILED|WAITING_HUMAN) ;; *) fail "恢复轮询超时（实际 $STATUS；见 recovery-worker.log）" ;; esac
[ "$STATUS" = DONE ] || fail "未完成（实际 $STATUS；见 recovery-worker.log）"

stop_recovery
STATUS=$(save_status final-status.json)
[ "$STATUS" = DONE ] || fail "最终任务不是 DONE（实际 $STATUS）"
audit "$EVIDENCE/audit-final.json"

EVIDENCE_DIR="$EVIDENCE" TASK_ID="$TASK" QUESTION_ID="$QID" DATABASE_NAME="$DB" HARNESS_KIND="$RUNNER" \
PI_PACKAGE_DIR="${PI_PACKAGE:-}" OMP_PACKAGE_DIR="${OMP_NODE_MODULES:-}" NODE_VERSION="$NODE_VERSION" HARNESS_VERSION="$HARNESS_VERSION" \
PI_VERSION="${PI_VERSION:-}" PI_ENTRY_SHA256="${PI_ENTRY_SHA256:-}" OMP_ENTRY_SHA256="${OMP_ENTRY_SHA256:-}" \
OMP_PACKAGE_VERSION="${OMP_PACKAGE_VERSION:-}" BUN_PACKAGE_VERSION="${BUN_PACKAGE_VERSION:-}" BUN_VERSION="${BUN_VERSION:-}" \
MODEL_ID="$MODEL" THINKING_LEVEL='max' \
node - <<'NODE' || fail '最终证据校验失败（见 final-status.json / audit-final.json）'
const fs = require('node:fs')
const path = require('node:path')
const {
  EVIDENCE_DIR: dir,
  TASK_ID: taskId,
  QUESTION_ID: questionId,
  DATABASE_NAME: database,
  HARNESS_KIND: harnessKind,
  PI_PACKAGE_DIR: piPackage,
  OMP_PACKAGE_DIR: ompPackage,
  NODE_VERSION: nodeVersion,
  HARNESS_VERSION: harnessVersion,
  PI_VERSION: piVersion,
  PI_ENTRY_SHA256: entrySha256,
  OMP_ENTRY_SHA256: ompEntrySha256,
  OMP_PACKAGE_VERSION: ompPackageVersion,
  BUN_PACKAGE_VERSION: bunPackageVersion,
  BUN_VERSION: bunVersion,
  MODEL_ID: modelId,
  THINKING_LEVEL: thinkingLevel,
} = process.env
const isNative = harnessKind === 'native-omp'
if (!isNative && harnessKind !== 'pi-compat') throw new Error(`unknown harness kind: ${harnessKind}`)
if (isNative) {
  if (harnessVersion !== 'omp/18.11.1') throw new Error(`native OMP version mismatch: ${harnessVersion}`)
  if (ompPackageVersion !== '18.11.1') throw new Error(`native OMP package version mismatch: ${ompPackageVersion}`)
  if (!bunVersion) throw new Error('missing Bun version')
} else if (!piPackage || !entrySha256) {
  throw new Error('missing Pi package evidence')
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
const status = read('final-status.json')
const audit = read('audit-final.json')
const question = read('questions.json').find((q) => q.id === questionId)
const report = status.report
const observations = Array.isArray(status.observations) ? status.observations : []
const citations = report && Array.isArray(report.citations) ? report.citations : []
const bad = citations.filter((c) => !observations.some((o) => o.path === c.path && o.digest === c.digest))
const events = Array.isArray(audit.events) ? audit.events : []
const attempts = Array.isArray(audit.attempts) ? audit.attempts : []
if (status.status !== 'DONE' || !report || report.outcome !== 'completed' || !report.report.trim()) throw new Error('report is not completed')
if (citations.length === 0 || bad.length > 0) throw new Error('citations do not match observations')
if (!events.some((e) => e.type === 'ManagedInvestigationCompleted') || !events.some((e) => e.type === 'ManagedHumanAnswered')) throw new Error('missing managed events')
if (!attempts.some((a) => a.phase === 'tianwen' && a.status === 'SUCCEEDED')) throw new Error('missing successful Tianwen attempt')
const evidence = {
  ok: true,
  evidence_dir: dir,
  database,
  harness_kind: harnessKind,
  harness_version: harnessVersion,
  omp_version: isNative ? harnessVersion : null,
  bun_version: isNative ? bunVersion : null,
  task_id: taskId,
  question_id: questionId,
  question,
  pre_answer_status: read('status-pre-answer.json'),
  pi_package: isNative ? null : piPackage,
  omp_package: isNative ? ompPackage : null,
  runtime: {
    node_version: nodeVersion,
    harness_kind: harnessKind,
    harness_version: harnessVersion,
    pi_version: isNative ? null : piVersion,
    pi_package_entry_sha256: isNative ? null : entrySha256,
    omp_version: isNative ? harnessVersion : null,
    omp_package_version: isNative ? ompPackageVersion : null,
    omp_package_entry_sha256: isNative ? ompEntrySha256 : null,
    bun_version: isNative ? bunVersion : null,
    bun_package_version: isNative ? bunPackageVersion : null,
    model: modelId,
    thinking: thinkingLevel,
  },
  billing_cost_verified: false,
  billing_note: '仅验证真实 token 用量；静态费用 0 是占位配置，实际账单未知，不能声称 0 费用。',
  pi_compatibility: isNative
    ? '原生 OMP runner 烟测；未执行故障注入、SIGKILL 或完整 JT02 验收'
    : 'Pi 兼容 runner 烟测；不能关闭原生 OMP/Claude 支持验收',
  report,
  citations_validated: true,
  status,
  audit,
}
fs.writeFileSync(path.join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
NODE

printf 'evidence: %s\n' "$EVIDENCE/evidence.json"
printf 'runner: %s\ntask: %s\nquestion: %s\n' "$RUNNER" "$TASK" "$QID"
if [ "$RUNNER" = native-omp ]; then
  printf 'omp: %s\nbun: %s\n' "$OMP_VERSION" "$BUN_VERSION"
  printf '边界: 原生 OMP runner 烟测；未执行故障注入与 SIGKILL 验收\n'
else
  printf '边界: Pi 兼容 runner 烟测；不能关闭原生 OMP/Claude 支持验收\n'
fi
