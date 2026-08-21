#!/usr/bin/env bash
# seam-acp remote bridge installer — macOS only (Bash 3.2 compatible).
#
# Does not require Xcode. Node is the official darwin tarball. Git is
# installed if missing (Homebrew when present, otherwise conda-forge via
# micromamba into ~/.seam/git) and the repo is always a real git clone.
#
# Fresh Mac (no git / no node):
#   curl -fsSL https://raw.githubusercontent.com/jbulpitt/seam-acp/main/scripts/install-macos-bridge.sh | bash
#
# From a clone:
#   bash scripts/install-macos-bridge.sh
#
# Paste the /seam bridge add line:
#   bash scripts/install-macos-bridge.sh --connect 'seam-bridge connect --server wss://… --id mac --token …'
#
# Non-interactive:
#   SEAM_CONNECT='seam-bridge connect --server wss://host/bridge --id mac --token TOKEN' \
#     bash scripts/install-macos-bridge.sh --cwd "$HOME/Projects" -y
#
# Reconfigure pairing only (skip clone/build):
#   bash scripts/install-macos-bridge.sh --skip-deps --connect '…'
#
# Self-test:
#   bash scripts/install-macos-bridge.sh --self-test
set -euo pipefail

REPO_SLUG="${SEAM_REPO_SLUG:-jbulpitt/seam-acp}"
REPO_BRANCH="${SEAM_REPO_BRANCH:-main}"
NODE_MAJOR_MIN=22
SEAM_HOME="${SEAM_HOME:-$HOME/.seam}"
DEFAULT_REPO_DIR="$SEAM_HOME/seam-acp"
NODE_PREFIX="$SEAM_HOME/node"
PM2_PREFIX="$SEAM_HOME"
APP_NAME_DEFAULT="seam-bridge"

YES=0
SKIP_DEPS=0
DEV=0
CONNECT_BLOB="${SEAM_CONNECT:-}"
CWD_ARG="${SEAM_BRIDGE_CWD:-}"
REPO_DIR_ARG=""
SELF_TEST=0

SERVER=""
BRIDGE_ID=""
TOKEN=""
CONNECT_CWD=""
CONNECT_DEV=0

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'xx  %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# conda-forge / micromamba platform id (pure; used by --self-test).
conda_platform_for() {
  case "$1" in
    arm64|aarch64) printf 'osx-arm64\n' ;;
    x86_64) printf 'osx-64\n' ;;
    *) return 1 ;;
  esac
}

conda_platform() {
  conda_platform_for "$(uname -m)"
}

git_public_url() {
  printf 'https://github.com/%s.git\n' "$REPO_SLUG"
}

is_yes() {
  case "$1" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Connect-line parser. Accepts the exact bootstrap from /seam bridge add,
# a whole Discord paste, or mixed flag order. Extra words are ignored.
# ---------------------------------------------------------------------------
trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

collapse_ws() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/`//g' -e 's/  */ /g' -e 's/^ //' -e 's/ $//'
}

parse_connect_blob() {
  SERVER=""
  BRIDGE_ID=""
  TOKEN=""
  CONNECT_CWD=""
  CONNECT_DEV=0

  # shellcheck disable=SC2086
  set -- $1
  while [ $# -gt 0 ]; do
    case "$1" in
      --server)
        [ $# -ge 2 ] || return 1
        SERVER=$2
        shift 2
        ;;
      --id|--bridge-id)
        [ $# -ge 2 ] || return 1
        BRIDGE_ID=$2
        shift 2
        ;;
      --token)
        [ $# -ge 2 ] || return 1
        TOKEN=$2
        shift 2
        ;;
      --cwd)
        [ $# -ge 2 ] || return 1
        CONNECT_CWD=$2
        shift 2
        ;;
      --dev)
        CONNECT_DEV=1
        shift
        ;;
      wss://*|ws://*)
        SERVER=$1
        shift
        ;;
      seam-bridge|remote-agent-bridge|connect)
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  [ -n "$SERVER" ] && [ -n "$BRIDGE_ID" ] && [ -n "$TOKEN" ]
}

run_self_test() {
  local fails=0
  expect_ok() {
    local name="$1"
    local blob="$2"
    local want_server="$3"
    local want_id="$4"
    local want_token="$5"
    if ! parse_connect_blob "$(collapse_ws "$blob")"; then
      printf 'FAIL %s: parse rejected\n' "$name"
      fails=$((fails + 1))
      return
    fi
    if [ "$SERVER" != "$want_server" ] || [ "$BRIDGE_ID" != "$want_id" ] || [ "$TOKEN" != "$want_token" ]; then
      printf 'FAIL %s: got server=%s id=%s token=%s\n' "$name" "$SERVER" "$BRIDGE_ID" "$TOKEN"
      fails=$((fails + 1))
      return
    fi
    printf 'ok   %s\n' "$name"
  }
  expect_fail() {
    local name="$1"
    local blob="$2"
    if parse_connect_blob "$(collapse_ws "$blob")"; then
      printf 'FAIL %s: expected reject, got server=%s id=%s\n' "$name" "$SERVER" "$BRIDGE_ID"
      fails=$((fails + 1))
      return
    fi
    printf 'ok   %s\n' "$name"
  }

  expect_ok "canonical" \
    "seam-bridge connect --server wss://seamacp.example/bridge --id media-server --token abc_def-123" \
    "wss://seamacp.example/bridge" "media-server" "abc_def-123"

  expect_ok "flag order" \
    "seam-bridge connect --token tok --id mac --server wss://host/bridge" \
    "wss://host/bridge" "mac" "tok"

  expect_ok "discord paste" \
    "Paired **mac**. Run this **once** on the host (token is not stored in plaintext and will not be shown again):
\`\`\`
seam-bridge connect --server wss://seamacp.runbooksynthesis.com/bridge --id mac --token THE_TOKEN
\`\`\`" \
    "wss://seamacp.runbooksynthesis.com/bridge" "mac" "THE_TOKEN"

  expect_ok "positional wss" \
    "wss://x.example/bridge leftover --id box --token t" \
    "wss://x.example/bridge" "box" "t"

  expect_ok "ws scheme" \
    "seam-bridge connect --server ws://localhost:3000/bridge --id local --token t" \
    "ws://localhost:3000/bridge" "local" "t"

  parse_connect_blob "$(collapse_ws "seam-bridge connect --server wss://h/b --id i --token t --cwd /Users/me/Projects --dev")"
  if [ "$CONNECT_CWD" != "/Users/me/Projects" ] || [ "$CONNECT_DEV" -ne 1 ]; then
    printf 'FAIL cwd/dev flags\n'
    fails=$((fails + 1))
  else
    printf 'ok   cwd/dev flags\n'
  fi

  expect_fail "missing token" "seam-bridge connect --server wss://h/b --id mac"
  expect_fail "empty" ""

  if [ "$(conda_platform_for arm64)" != "osx-arm64" ] || [ "$(conda_platform_for x86_64)" != "osx-64" ]; then
    printf 'FAIL conda_platform_for\n'
    fails=$((fails + 1))
  else
    printf 'ok   conda_platform_for\n'
  fi

  if [ "$(git_public_url)" != "https://github.com/${REPO_SLUG}.git" ]; then
    printf 'FAIL git_public_url\n'
    fails=$((fails + 1))
  else
    printf 'ok   git_public_url\n'
  fi

  if is_yes yes && is_yes Y && is_yes y && ! is_yes n && ! is_yes "" && ! is_yes no; then
    printf 'ok   is_yes\n'
  else
    printf 'FAIL is_yes\n'
    fails=$((fails + 1))
  fi

  if [ "$fails" -ne 0 ]; then
    printf '%s self-test failure(s)\n' "$fails" >&2
    exit 1
  fi
  printf 'all parser tests passed\n'
  exit 0
}

# ---------------------------------------------------------------------------
usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --self-test) SELF_TEST=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --dev) DEV=1; shift ;;
    --connect)
      [ $# -ge 2 ] || die "--connect needs the bootstrap line"
      CONNECT_BLOB=$2
      shift 2
      ;;
    --cwd)
      [ $# -ge 2 ] || die "--cwd needs a path"
      CWD_ARG=$2
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a path"
      REPO_DIR_ARG=$2
      shift 2
      ;;
    *)
      die "unknown argument: $1 (see --help)"
      ;;
  esac
done

if [ "$SELF_TEST" -eq 1 ]; then
  run_self_test
fi

if [ "$YES" -eq 1 ] && [ -z "$CONNECT_BLOB" ]; then
  die "-y/--yes requires --connect 'seam-bridge connect …' (or SEAM_CONNECT)"
fi

# ---------------------------------------------------------------------------
# Prompting. Prefer /dev/tty so `curl | bash` still works in a real terminal.
# ---------------------------------------------------------------------------
tty_read() {
  local prompt="$1"
  local dest="$2"
  local def="${3:-}"
  # Must not be named `reply` — confirm() also uses that, and bash `local`
  # is dynamically scoped so eval would write THIS function's copy.
  local line=""
  if [ -r /dev/tty ]; then
    if [ -n "$def" ]; then
      printf '%s [%s]: ' "$prompt" "$def" > /dev/tty
    else
      printf '%s ' "$prompt" > /dev/tty
    fi
    IFS= read -r line < /dev/tty || true
  elif [ -t 0 ]; then
    if [ -n "$def" ]; then
      printf '%s [%s]: ' "$prompt" "$def"
    else
      printf '%s ' "$prompt"
    fi
    IFS= read -r line || true
  else
    line=""
  fi
  line=$(trim "$line")
  if [ -z "$line" ]; then
    line=$def
  fi
  eval "$dest=\"\$line\""
}

confirm() {
  local prompt="$1"
  local ans=""
  if [ "$YES" -eq 1 ]; then
    return 0
  fi
  tty_read "$prompt [y/N]" ans "n"
  is_yes "$ans"
}

# ---------------------------------------------------------------------------
require_macos() {
  local os
  os=$(uname -s)
  if [ "$os" != "Darwin" ]; then
    die "This installer currently supports macOS only (got $os)."
  fi
}

node_major() {
  node -v 2>/dev/null | sed -e 's/^v//' -e 's/\..*//'
}

git_works() {
  have git || return 1
  local out
  out=$(git --version 2>&1) || return 1
  case "$out" in
    "git version"*) return 0 ;;
    *) return 1 ;;
  esac
}

node_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64\n' ;;
    x86_64) printf 'x64\n' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

prepend_path() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) PATH="$dir:$PATH" ;;
  esac
  export PATH
}

agent_path() {
  command -v "$1" 2>/dev/null || printf '(not on PATH)\n'
}

# JSON string without python (macOS python3 is often an Xcode stub).
json_str() {
  printf '"'
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
  printf '"'
}

investigate() {
  local sw_vers macosver
  macosver=$(sw_vers -productVersion 2>/dev/null || echo "?")
  log "Environment"
  info "os:      macOS $macosver ($(uname -m))"
  info "user:    $(id -un)  home=$HOME"
  info "shell:   ${SHELL:-?}"
  if git_works; then
    info "git:     $(git --version) @ $(command -v git)"
  else
    info "git:     missing or CLT stub — will install a real git, then clone"
  fi
  if have node; then
    info "node:    $(node -v) @ $(command -v node)"
  else
    info "node:    not found — will install $NODE_MAJOR_MIN.x to $NODE_PREFIX"
  fi
  if have npm; then
    info "npm:     $(npm -v) @ $(command -v npm)"
  else
    info "npm:     not found"
  fi
  if have pm2; then
    info "pm2:     $(pm2 -v) @ $(command -v pm2)"
  else
    info "pm2:     not found — will install under $PM2_PREFIX"
  fi
  info "xcode:   $(xcode-select -p 2>/dev/null || echo 'not installed (ok — not required)')"
  info "agents on PATH (optional — inventory skips missing CLIs):"
  info "  grok:            $(agent_path grok)"
  info "  claude-agent-acp:$(agent_path claude-agent-acp)"
  info "  copilot:         $(agent_path copilot)"
  info "  agy:             $(agent_path agy)"
  info "  opencode:        $(agent_path opencode)"
  info "  codex-acp:       $(agent_path codex-acp)"
}

# ---------------------------------------------------------------------------
ensure_node() {
  prepend_path "$NODE_PREFIX/bin"
  if have node; then
    local major
    major=$(node_major)
    if [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR_MIN" ]; then
      log "Node $(node -v) is new enough"
      return 0
    fi
    warn "Node $(node -v) is older than v$NODE_MAJOR_MIN — installing a private copy"
  else
    log "Installing Node $NODE_MAJOR_MIN.x (official darwin tarball, no Xcode)"
  fi

  local arch tarball_name url tmp
  arch=$(node_arch)
  tarball_name=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR_MIN}.x/SHASUMS256.txt" \
    | awk -v arch="$arch" '
        $2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") { print $2; exit }
      ')
  [ -n "$tarball_name" ] || die "could not find a darwin-$arch Node $NODE_MAJOR_MIN tarball on nodejs.org"
  url="https://nodejs.org/dist/latest-v${NODE_MAJOR_MIN}.x/$tarball_name"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/seam-node.XXXXXX")
  info "downloading $url"
  curl -fL --progress-bar "$url" -o "$tmp/node.tar.gz"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  local extracted="" d
  for d in "$tmp"/node-v*; do
    if [ -d "$d" ]; then
      extracted=$d
      break
    fi
  done
  [ -n "$extracted" ] && [ -d "$extracted" ] || die "failed to unpack Node tarball"
  rm -rf "$NODE_PREFIX"
  mkdir -p "$SEAM_HOME"
  mv "$extracted" "$NODE_PREFIX"
  rm -rf "$tmp"
  prepend_path "$NODE_PREFIX/bin"
  have node || die "node still missing after install"
  log "Node $(node -v) ready at $NODE_PREFIX/bin/node"
}

# ---------------------------------------------------------------------------
detect_existing_repo() {
  if [ -n "$REPO_DIR_ARG" ]; then
    printf '%s\n' "$REPO_DIR_ARG"
    return
  fi
  if [ -f "$PWD/packages/bridge/package.json" ]; then
    printf '%s\n' "$PWD"
    return
  fi
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local here
    here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || here=""
    if [ -n "$here" ] && [ -f "$here/packages/bridge/package.json" ]; then
      printf '%s\n' "$here"
      return
    fi
  fi
  printf '%s\n' "$DEFAULT_REPO_DIR"
}

clone_into() {
  local dest="$1"
  local url token
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  mkdir -p "$(dirname "$dest")"
  if [ -n "$token" ]; then
    url="https://x-access-token:${token}@github.com/${REPO_SLUG}.git"
  else
    url=$(git_public_url)
  fi
  info "git clone --depth 1 --branch $REPO_BRANCH github.com/${REPO_SLUG} -> $dest"
  git clone --depth 1 --branch "$REPO_BRANCH" "$url" "$dest"
}

install_git_conda() {
  local plat tmp mm
  plat=$(conda_platform) || die "unsupported arch for conda-forge git: $(uname -m)"
  log "Installing git from conda-forge via micromamba (no Xcode)"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/seam-git.XXXXXX")
  info "downloading micromamba ($plat)"
  if ! curl -fL "https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-${plat}.tar.bz2" \
      -o "$tmp/micromamba.tar.bz2"; then
    info "GitHub release missed — trying micro.mamba.pm"
    curl -fL "https://micro.mamba.pm/api/micromamba/${plat}/latest" -o "$tmp/micromamba.tar.bz2" \
      || die "could not download micromamba"
  fi
  tar -xjf "$tmp/micromamba.tar.bz2" -C "$tmp"
  mm=""
  for f in "$tmp/bin/micromamba" "$tmp/micromamba" "$tmp"/*/micromamba; do
    if [ -f "$f" ]; then
      mm=$f
      break
    fi
  done
  [ -n "$mm" ] && [ -f "$mm" ] || die "micromamba binary missing from archive"
  chmod +x "$mm"
  xattr -dr com.apple.quarantine "$mm" 2>/dev/null || true
  export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$SEAM_HOME/mamba}"
  mkdir -p "$MAMBA_ROOT_PREFIX" "$SEAM_HOME"
  rm -rf "$SEAM_HOME/git"
  "$mm" create -y -p "$SEAM_HOME/git" -c conda-forge git \
    || die "micromamba failed to install git"
  rm -rf "$tmp"
  [ -x "$SEAM_HOME/git/bin/git" ] || die "conda-forge git did not land at $SEAM_HOME/git/bin/git"
}

ensure_git() {
  prepend_path "$SEAM_HOME/git/bin"
  if git_works; then
    log "git $(git --version | sed -n '1p') ready"
    return 0
  fi

  if have brew; then
    log "Installing git with Homebrew"
    if brew install git; then
      if git_works; then
        log "git $(git --version | sed -n '1p') ready (Homebrew)"
        return 0
      fi
    else
      warn "brew install git failed — trying a standalone git"
    fi
  fi

  install_git_conda
  prepend_path "$SEAM_HOME/git/bin"
  git_works || die "git still missing after install (Apple's /usr/bin/git stub does not count)"
  log "git $(git --version | sed -n '1p') ready at $SEAM_HOME/git/bin/git"
}

ensure_repo() {
  REPO_DIR=$(detect_existing_repo)

  if [ -d "$REPO_DIR/.git" ] && [ -f "$REPO_DIR/packages/bridge/package.json" ]; then
    log "Using existing clone at $REPO_DIR"
    info "git pull --ff-only"
    (cd "$REPO_DIR" && git pull --ff-only) || warn "git pull failed — continuing with what's on disk"
    return 0
  fi

  if [ -f "$REPO_DIR/packages/bridge/package.json" ] && [ ! -d "$REPO_DIR/.git" ]; then
    log "Sources at $REPO_DIR have no .git — replacing with a clone"
    local bak="${REPO_DIR}.bak-preclone"
    rm -rf "$bak"
    mv "$REPO_DIR" "$bak"
    if clone_into "$REPO_DIR"; then
      rm -rf "$bak"
      return 0
    fi
    rm -rf "$REPO_DIR"
    mv "$bak" "$REPO_DIR"
    die "clone failed; restored the previous sources at $REPO_DIR. If the repo is private, export GH_TOKEN."
  fi

  log "Cloning seam-acp into $REPO_DIR"
  if [ -e "$REPO_DIR" ]; then
    die "$REPO_DIR exists but is not a seam-acp checkout. Move it aside or pass --dir."
  fi
  clone_into "$REPO_DIR" || die "git clone failed. If the repo is private, export GH_TOKEN and retry."
}

# ---------------------------------------------------------------------------
ensure_built() {
  log "Installing JS deps and building the bridge (adapters + bridge only)"
  cd "$REPO_DIR"
  export npm_config_build_from_source=false
  npm install --no-audit --no-fund \
    --workspace=@seam/adapters \
    --workspace=@seam/bridge
  # typescript lives on the workspace root; needed to emit dist/.
  if ! have tsc && [ ! -x "$REPO_DIR/node_modules/.bin/tsc" ]; then
    npm install --no-audit --no-fund --no-save typescript
  fi
  npm run build -w @seam/adapters
  npm run build -w @seam/bridge
  [ -f "$REPO_DIR/packages/bridge/dist/index.js" ] || die "bridge build did not produce dist/index.js"
}

ensure_pm2() {
  prepend_path "$PM2_PREFIX/bin"
  if have pm2; then
    log "pm2 $(pm2 -v) already installed"
    return 0
  fi
  log "Installing pm2 under $PM2_PREFIX (no sudo)"
  npm install -g pm2 --prefix "$PM2_PREFIX" --no-audit --no-fund
  prepend_path "$PM2_PREFIX/bin"
  have pm2 || die "pm2 install failed"
}

# ---------------------------------------------------------------------------
prompt_connect() {
  if [ -n "$CONNECT_BLOB" ]; then
    parse_connect_blob "$(collapse_ws "$CONNECT_BLOB")" || \
      die "could not parse --connect / SEAM_CONNECT (need --server, --id, and --token)"
    return 0
  fi

  log "Pairing"
  info "On Discord run /seam bridge add (admin). Copy the one-line bootstrap."
  info "You can paste the whole ephemeral message — the script picks out the flags."
  local blob=""
  tty_read "Paste the connect command (or the whole message):" blob ""
  if [ -z "$blob" ]; then
    local s i t
    tty_read "Server wss URL:" s ""
    tty_read "Bridge id:" i ""
    tty_read "Token:" t ""
    blob="--server $s --id $i --token $t"
  fi
  parse_connect_blob "$(collapse_ws "$blob")" || \
    die "could not find --server, --id, and --token in that paste"
}

prompt_cwd() {
  if [ -n "$CWD_ARG" ]; then
    WORKSPACE_ROOT=$CWD_ARG
  elif [ -n "$CONNECT_CWD" ]; then
    WORKSPACE_ROOT=$CONNECT_CWD
  else
    local def="$HOME"
    if [ -d "$HOME/Projects" ]; then
      def="$HOME/Projects"
    fi
    if [ "$YES" -eq 1 ]; then
      WORKSPACE_ROOT=$def
    else
      tty_read "Workspace root the bridge should expose" WORKSPACE_ROOT "$def"
    fi
  fi
  case "$WORKSPACE_ROOT" in
    ~) WORKSPACE_ROOT=$HOME ;;
    ~/*) WORKSPACE_ROOT="$HOME/${WORKSPACE_ROOT#~/}" ;;
  esac
  mkdir -p "$WORKSPACE_ROOT" 2>/dev/null || true
  [ -d "$WORKSPACE_ROOT" ] || die "workspace root is not a directory: $WORKSPACE_ROOT"
}

prompt_dev() {
  if [ "$DEV" -eq 1 ] || [ "$CONNECT_DEV" -eq 1 ]; then
    DEV=1
    return
  fi
  if [ "$YES" -eq 1 ]; then
    DEV=0
    return
  fi
  if confirm "Enable --dev (lets /seam debug exec/tail on this Mac)?"; then
    DEV=1
  else
    DEV=0
  fi
}

# ---------------------------------------------------------------------------
write_wrapper() {
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/seam-bridge" <<EOF
#!/bin/sh
exec "$(command -v node)" "$REPO_DIR/packages/bridge/dist/index.js" "\$@"
EOF
  chmod 755 "$HOME/.local/bin/seam-bridge"
  prepend_path "$HOME/.local/bin"
}

write_and_start_pm2() {
  local conf_dir eco envfile node_bin pm2_name args extra_path
  conf_dir="$SEAM_HOME/bridge"
  mkdir -p "$conf_dir"
  eco="$conf_dir/ecosystem.config.cjs"
  envfile="$conf_dir/bridge.env"
  node_bin=$(command -v node)

  extra_path="$SEAM_HOME/git/bin:$NODE_PREFIX/bin:$PM2_PREFIX/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.fnm/aliases/default/bin:$PATH"

  cat > "$envfile" <<EOF
SEAM_BRIDGE_SERVER=$SERVER
SEAM_BRIDGE_ID=$BRIDGE_ID
SEAM_BRIDGE_TOKEN=$TOKEN
SEAM_BRIDGE_CWD=$WORKSPACE_ROOT
SEAM_BRIDGE_DEV=$DEV
EOF
  chmod 600 "$envfile"

  args="connect --server $SERVER --id $BRIDGE_ID --token $TOKEN --cwd $WORKSPACE_ROOT"
  if [ "$DEV" -eq 1 ]; then
    args="$args --dev"
  fi

  pm2_name=$APP_NAME_DEFAULT
  if have pm2; then
    if pm2 describe remote-agent-bridge >/dev/null 2>&1; then
      pm2_name="remote-agent-bridge"
      info "reusing existing pm2 app name: $pm2_name"
    fi
  fi

  {
    printf 'module.exports = {\n'
    printf '  apps: [\n'
    printf '    {\n'
    printf '      name: %s,\n' "$(json_str "$pm2_name")"
    printf '      cwd: %s,\n' "$(json_str "$REPO_DIR")"
    printf '      script: "packages/bridge/dist/index.js",\n'
    printf '      interpreter: %s,\n' "$(json_str "$node_bin")"
    printf '      args: %s,\n' "$(json_str "$args")"
    printf '      restart_delay: 3000,\n'
    printf '      max_restarts: 20,\n'
    printf '      kill_timeout: 30000,\n'
    printf '      env: {\n'
    printf '        PATH: %s,\n' "$(json_str "$extra_path")"
    printf '        SEAM_BRIDGE_DEV: %s,\n' "$( [ "$DEV" -eq 1 ] && json_str 1 || json_str "" )"
    printf '      },\n'
    printf '    },\n'
    printf '  ],\n'
    printf '};\n'
  } > "$eco"
  chmod 600 "$eco"

  log "Starting $pm2_name with pm2"
  if pm2 describe "$pm2_name" >/dev/null 2>&1; then
    pm2 delete "$pm2_name" >/dev/null 2>&1 || true
  fi
  pm2 start "$eco"
  pm2 save

  info "status:  pm2 status"
  info "logs:    pm2 logs $pm2_name"
  info "restart: pm2 restart $pm2_name"
  info "login:   pm2 startup launchd    # then run the command it prints (once)"
}

# ---------------------------------------------------------------------------
main() {
  require_macos
  investigate

  if [ "$SKIP_DEPS" -eq 0 ]; then
    ensure_node
    ensure_git
    ensure_repo
    ensure_built
    ensure_pm2
    write_wrapper
  else
    prepend_path "$SEAM_HOME/git/bin"
    prepend_path "$NODE_PREFIX/bin"
    prepend_path "$PM2_PREFIX/bin"
    REPO_DIR=$(detect_existing_repo)
    [ -f "$REPO_DIR/packages/bridge/dist/index.js" ] || die "--skip-deps needs a built repo at $REPO_DIR"
    have pm2 || die "--skip-deps needs pm2 on PATH"
  fi

  prompt_connect
  prompt_cwd
  prompt_dev

  log "Will run:"
  info "seam-bridge connect --server $SERVER --id $BRIDGE_ID --token *** --cwd $WORKSPACE_ROOT$( [ "$DEV" -eq 1 ] && printf ' --dev' )"
  if ! confirm "Start / restart the bridge under pm2?"; then
    die "aborted"
  fi

  write_and_start_pm2
  log "Done. On Discord, /seam bridge list should show $BRIDGE_ID connected."
  info "Agent CLIs (grok, claude, copilot, …) are optional — install the ones you want; the bridge advertises whatever is on PATH."
}

main
