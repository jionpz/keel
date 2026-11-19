#!/bin/sh
# Candidate contract: compiled CLI + migrations + prod-only deps must work.
# Never call a model, GitHub API, user database or production deployment here.
set -eu
umask 077

pnpm run build

tmp=$(mktemp -d "${TMPDIR:-/tmp}/keel-package.XXXXXX")
trap 'rm -rf "$tmp"' 0
stage="$tmp/keel"
mkdir -p "$stage"
cp package.json pnpm-lock.yaml README.md "$stage/"
cp -R dist migrations "$stage/"
source_commit="${GITHUB_SHA:-$(git rev-parse HEAD)}"
printf '%s\n' "$source_commit" > "$stage/SOURCE_COMMIT"

(
  cd "$stage"
  # A development install would hide missing runtime dependencies.
  pnpm install --prod --frozen-lockfile --ignore-scripts
  test -s dist/cli/index.js
  test -x node_modules/.bin/node-pg-migrate
  node dist/cli/index.js --help >/dev/null
  node dist/cli/index.js --version >/dev/null
)
echo "✓ candidate: production dependencies, migrations and compiled CLI verified"

# Optional CI delivery archive; local `pnpm run check:package` stays check-only.
if [ -n "${KEEL_CANDIDATE_DIR:-}" ]; then
  mkdir -p "$KEEL_CANDIDATE_DIR"
  rm -rf "$stage/node_modules"
  short_sha=$(printf '%s' "$source_commit" | cut -c 1-12)
  name="keel-$short_sha.tar.gz"
  tar -C "$tmp" -czf "$KEEL_CANDIDATE_DIR/$name" keel
  (
    cd "$KEEL_CANDIDATE_DIR"
    shasum -a 256 "$name" > "$name.sha256"
  )
  echo "✓ SHA-256 candidate archive: $KEEL_CANDIDATE_DIR/$name"
fi
