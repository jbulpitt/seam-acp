#!/bin/sh
# Fixed remote half of scripts/bridge-rollout.mjs. It is streamed over SSH and
# accepts only locally allowlisted identifiers and exact hex artifact identities.
set -eu

fail() { printf 'error=%s\n' "$1" >&2; exit 1; }
safe_name() { case "$1" in ''|*[!a-z0-9._-]*) return 1 ;; *) return 0 ;; esac; }
safe_sha() { test "${#1}" -eq 40 && case "$1" in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac; }
safe_checksum() { test "${#1}" -eq 64 && case "$1" in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac; }

mode=${1:-}
app=${2:-}
bridge_id=${3:-}
verify_agent=${4:-}
safe_name "$mode" || fail "unsafe mode"
safe_name "$app" || fail "unsafe PM2 app"
safe_name "$bridge_id" || fail "unsafe bridge id"
safe_name "$verify_agent" || fail "unsafe verification agent"

root=$HOME/.seam/bridge-rollouts

pid_file_for_app() {
  found=
  for candidate in "$HOME/.pm2/pids/$app-"*.pid; do
    test -f "$candidate" || continue
    test -z "$found" || fail "multiple PM2 pid files match the configured app"
    found=$candidate
  done
  test -n "$found" || fail "configured PM2 app has no pid file"
  printf '%s\n' "$found"
}

live_pid() {
  pf=$(pid_file_for_app)
  pid=$(tr -d '[:space:]' < "$pf")
  case "$pid" in ''|*[!0-9]*) fail "configured PM2 app has an invalid pid" ;; esac
  test "$pid" -gt 0 || fail "configured PM2 app is stopped"
  kill -0 "$pid" 2>/dev/null || fail "configured PM2 pid is not alive"
  printf '%s\n' "$pid"
}

cwd_for_pid() {
  cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  test -n "$cwd" || fail "could not determine bridge cwd without process arguments"
  case "$cwd" in *[!A-Za-z0-9_./-]*) fail "bridge cwd contains unsupported characters" ;; esac
  printf '%s\n' "$cwd"
}

find_node() {
  for candidate in "$HOME/.seam/node/bin/node" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    test -x "$candidate" || continue
    major=$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
    case "$major" in ''|*[!0-9]*) continue ;; esac
    test "$major" -ge 22 || continue
    printf '%s\n' "$candidate"
    return
  done
  fail "Node 22 or newer is unavailable"
}

git_head_without_git() {
  checkout=$1
  head=$(sed -n '1p' "$checkout/.git/HEAD" 2>/dev/null || true)
  case "$head" in
    'ref: refs/'*)
      ref=${head#ref: }
      case "$ref" in *[!A-Za-z0-9_./-]*) return ;; esac
      if test -f "$checkout/.git/$ref"; then sed -n '1p' "$checkout/.git/$ref"; return; fi
      awk -v wanted="$ref" '$2 == wanted { print $1; exit }' "$checkout/.git/packed-refs" 2>/dev/null || true
      ;;
    *) printf '%s\n' "$head" ;;
  esac
}

archive_hash() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else fail "no SHA-256 tool is available"
  fi
}

preflight() {
  pid=$(live_pid)
  cwd=$(cwd_for_pid "$pid")
  entry=$cwd/packages/bridge/dist/index.js
  test -f "$entry" || fail "expected bridge entrypoint is absent"
  node=$(find_node)
  npm=$(dirname "$node")/npm
  test -x "$npm" || fail "npm is unavailable beside Node"
  identity=$(git_head_without_git "$cwd")
  test -n "$identity" || identity=unknown
  active_dist=$(dirname "$entry")
  if test -L "$entry"; then
    release_entry=$(cd "$(dirname "$entry")" && cd "$(dirname "$(readlink "$entry")")" && pwd -P)/$(basename "$(readlink "$entry")")
    active_dist=$(dirname "$release_entry")
    state=$(cd "$(dirname "$release_entry")/../../.." && pwd -P)/bridge-release-state.json
    if test -f "$state"; then
      release_identity=$($node -e 'const j=require(process.argv[1]); process.stdout.write(j.sourceSha+" "+j.artifactChecksum)' "$state" 2>/dev/null || true)
      test -z "$release_identity" || identity=$release_identity
    fi
  fi
  rpc=$active_dist/rpc.js
  version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$active_dist/../package.json" 2>/dev/null | sed -n '1p')
  test -n "$version" || version=unknown
  grep -q 'SIGUSR2' "$entry" && drain=yes || drain=no
  grep -q 'describeModelCatalog' "$rpc" 2>/dev/null && describe=yes || describe=no
  grep -q 'fetchModelCatalog' "$rpc" 2>/dev/null && fetch=yes || fetch=no
  protocol=$(sed -n 's/.*PROTOCOL_VERSION = \([0-9][0-9]*\).*/\1/p' "$active_dist/../../adapters/dist/command-bus.js" 2>/dev/null | sed -n '1p')
  test -n "$protocol" || protocol=unknown
  npm_version=$(PATH="$(dirname "$node"):$PATH" "$npm" --version 2>/dev/null || printf unavailable)
  disk=$(df -Pk "$HOME" | awk 'END { print $4 }')
  printf 'reachable=yes\n'
  printf 'platform=%s\n' "$(uname -srm)"
  printf 'pm2_app=%s\n' "$app"
  printf 'pid=%s\n' "$pid"
  printf 'cwd=%s\n' "$cwd"
  printf 'artifact_identity=%s\n' "$identity"
  printf 'bridge_version=%s\n' "$version"
  printf 'protocol_version=%s\n' "$protocol"
  printf 'describeModelCatalog=%s\n' "$describe"
  printf 'fetchModelCatalog=%s\n' "$fetch"
  printf 'drain_SIGUSR2=%s\n' "$drain"
  printf 'node_path=%s\n' "$node"
  printf 'node_version=%s\n' "$($node --version)"
  printf 'npm_version=%s\n' "$npm_version"
  printf 'disk_kb_available=%s\n' "$disk"
}

wait_new_pid() {
  old_pid=$1
  timeout=$2
  elapsed=0
  while test "$elapsed" -le "$timeout"; do
    new_pid=$(live_pid 2>/dev/null || true)
    if test -n "$new_pid" && test "$new_pid" != "$old_pid"; then printf '%s\n' "$new_pid"; return; fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  fail "timed out waiting for a new PM2 pid"
}

case "$mode" in
  preflight)
    test "$#" -eq 4 || fail "preflight argument count"
    preflight
    ;;
  prepare-upload)
    test "$#" -eq 4 || fail "prepare-upload argument count"
    mkdir -p "$root/incoming" "$root/releases" "$root/state" "$root/ready"
    printf 'upload_ready=yes\n'
    ;;
  stage)
    test "$#" -eq 7 || fail "stage argument count"
    sha=$5
    checksum=$6
    name=$7
    safe_sha "$sha" || fail "unsafe source sha"
    safe_checksum "$checksum" || fail "unsafe artifact checksum"
    test "$name" = "bridge-$sha-$checksum.tgz" || fail "artifact filename does not match identity"
    archive=$root/incoming/$name
    test -f "$archive" || fail "uploaded artifact is absent"
    actual=$(archive_hash "$archive")
    test "$actual" = "$checksum" || fail "artifact checksum mismatch"
    release=$root/releases/$sha-$checksum
    if test -d "$release"; then
      test -f "$release/bridge-release-state.json" || fail "existing release is incomplete"
      printf 'staged_release=%s\n' "$release"
      printf 'artifact_checksum=%s\n' "$checksum"
      exit 0
    fi
    partial=$release.partial-$$
    test ! -e "$partial" || fail "staging path already exists"
    mkdir "$partial"
    tar -xzf "$archive" -C "$partial"
    manifest_sha=$(sed -n 's/.*"sourceSha":"\([0-9a-f]*\)".*/\1/p' "$partial/bridge-release.json" | sed -n '1p')
    test "$manifest_sha" = "$sha" || fail "artifact manifest SHA mismatch"
    node=$(find_node)
    npm=$(dirname "$node")/npm
    test -x "$npm" || fail "npm is unavailable beside Node"
    (cd "$partial" && PATH="$(dirname "$node"):$PATH" "$npm" ci --omit=dev --workspace=@seam/adapters --workspace=@seam/bridge --no-audit --no-fund)
    test -f "$partial/packages/bridge/dist/index.js" || fail "staged bridge entrypoint is absent"
    test -f "$partial/packages/bridge/dist/rpc.js" || fail "staged bridge RPC module is absent"
    grep -q 'SIGUSR2' "$partial/packages/bridge/dist/index.js" || fail "staged bridge lacks SIGUSR2 drain"
    grep -q 'describeModelCatalog' "$partial/packages/bridge/dist/rpc.js" || fail "staged bridge lacks describeModelCatalog"
    grep -q 'fetchModelCatalog' "$partial/packages/bridge/dist/rpc.js" || fail "staged bridge lacks fetchModelCatalog"
    umask 077
    printf '{"sourceSha":"%s","artifactChecksum":"%s","verificationAgent":"%s"}\n' "$sha" "$checksum" "$verify_agent" > "$partial/bridge-release-state.json"
    mv "$partial" "$release"
    printf 'staged_release=%s\n' "$release"
    printf 'artifact_checksum=%s\n' "$checksum"
    ;;
  activate)
    test "$#" -eq 7 || fail "activate argument count"
    sha=$5
    checksum=$6
    timeout=$7
    safe_sha "$sha" || fail "unsafe source sha"
    safe_checksum "$checksum" || fail "unsafe artifact checksum"
    case "$timeout" in ''|*[!0-9]*) fail "unsafe timeout" ;; esac
    test "$timeout" -ge 10 && test "$timeout" -le 900 || fail "timeout out of bounds"
    old_pid=$(live_pid)
    cwd=$(cwd_for_pid "$old_pid")
    entry=$cwd/packages/bridge/dist/index.js
    release=$root/releases/$sha-$checksum
    new_entry=$release/packages/bridge/dist/index.js
    test -f "$new_entry" || fail "requested staged release is absent"
    test "$(sed -n 's/.*"sourceSha":"\([0-9a-f]*\)".*/\1/p' "$release/bridge-release-state.json")" = "$sha" || fail "staged release identity mismatch"
    test "$(sed -n 's/.*"artifactChecksum":"\([0-9a-f]*\)".*/\1/p' "$release/bridge-release-state.json")" = "$checksum" || fail "staged release checksum identity mismatch"
    test "$(sed -n 's/.*"verificationAgent":"\([a-z0-9._-]*\)".*/\1/p' "$release/bridge-release-state.json")" = "$verify_agent" || fail "staged release verification agent mismatch"
    test "$(archive_hash "$root/incoming/bridge-$sha-$checksum.tgz")" = "$checksum" || fail "staged archive checksum no longer matches"
    if test -L "$entry"; then
      previous=$(cd "$(dirname "$entry")" && cd "$(dirname "$(readlink "$entry")")" && pwd -P)/$(basename "$(readlink "$entry")")
    else
      active=$(git_head_without_git "$cwd")
      safe_sha "$active" || active=pid-$old_pid
      previous=$(dirname "$entry")/index.seam-previous-$active.js
      test ! -e "$previous" || fail "legacy previous-good entrypoint already exists"
      ln "$entry" "$previous"
    fi
    test -f "$previous" || fail "previous-good entrypoint is absent"
    test "$previous" != "$new_entry" || fail "requested release is already active"
    rollback_command="npm run bridge:rollout -- --target $bridge_id --rollback --apply"
    state=$root/state/$bridge_id.json
    state_tmp=$state.next-$$
    umask 077
    printf '{"bridgeId":"%s","pm2App":"%s","previousTarget":"%s","activatedTarget":"%s","sourceSha":"%s","artifactChecksum":"%s","rollbackCommand":"%s"}\n' "$bridge_id" "$app" "$previous" "$new_entry" "$sha" "$checksum" "$rollback_command" > "$state_tmp"
    mv "$state_tmp" "$state"
    next=$entry.seam-next-$$
    ln -s "$new_entry" "$next"
    mv -f "$next" "$entry"
    started=$(date +%s)
    kill -USR2 "$old_pid" || fail "SIGUSR2 graceful drain signal failed; activation stopped"
    new_pid=$(wait_new_pid "$old_pid" "$timeout")
    receipt=$root/ready/$bridge_id.json
    elapsed=0
    now_epoch=$(date +%s)
    spent=$((now_epoch - started))
    receipt_timeout=$((timeout - spent))
    test "$receipt_timeout" -ge 0 || receipt_timeout=0
    node=$(find_node)
    while test "$elapsed" -le "$receipt_timeout"; do
      if test -f "$receipt" && "$node" -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c=j.catalogRpcs?.[process.argv[5]]; process.exit(j.sourceSha===process.argv[2]&&j.artifactChecksum===process.argv[3]&&j.pid===Number(process.argv[4])&&j.protocolVersion===1&&j.helloAcceptedAt&&j.controllerVerifiedAt&&c?.describeModelCatalogAt&&c?.fetchModelCatalogAt?0:1)' "$receipt" "$sha" "$checksum" "$new_pid" "$verify_agent"; then
        printf 'activation=verified\n'
        printf 'old_pid=%s\n' "$old_pid"
        printf 'new_pid=%s\n' "$new_pid"
        printf 'ready_handshake=fresh\n'
        printf 'catalog_rpc_agent=%s\n' "$verify_agent"
        printf 'rollback_command=%s\n' "$rollback_command"
        exit 0
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
    fail "new PID started but ready/catalog RPC verification timed out; rollout stopped and rollback requires explicit authorization"
    ;;
  rollback)
    test "$#" -eq 5 || fail "rollback argument count"
    timeout=$5
    case "$timeout" in ''|*[!0-9]*) fail "unsafe timeout" ;; esac
    test "$timeout" -ge 10 && test "$timeout" -le 900 || fail "timeout out of bounds"
    state=$root/state/$bridge_id.json
    test -f "$state" || fail "no previous-good rollback record exists"
    node=$(find_node)
    previous=$($node -e 'const j=require(process.argv[1]); if(j.bridgeId!==process.argv[2]||j.pm2App!==process.argv[3])process.exit(2); process.stdout.write(j.previousTarget)' "$state" "$bridge_id" "$app")
    old_pid=$(live_pid)
    cwd=$(cwd_for_pid "$old_pid")
    case "$previous" in
      "$root"/releases/*/packages/bridge/dist/index.js|"$cwd"/packages/bridge/dist/index.seam-previous-*.js) ;;
      *) fail "recorded previous-good path is outside allowed release locations" ;;
    esac
    test -f "$previous" || fail "recorded previous-good entrypoint is absent"
    entry=$cwd/packages/bridge/dist/index.js
    next=$entry.seam-rollback-$$
    ln -s "$previous" "$next"
    mv -f "$next" "$entry"
    kill -USR2 "$old_pid" || fail "SIGUSR2 graceful rollback signal failed"
    new_pid=$(wait_new_pid "$old_pid" "$timeout")
    printf 'rollback=pid-verified\n'
    printf 'old_pid=%s\n' "$old_pid"
    printf 'new_pid=%s\n' "$new_pid"
    printf 'previous_good=%s\n' "$previous"
    ;;
  *) fail "unknown mode" ;;
esac
