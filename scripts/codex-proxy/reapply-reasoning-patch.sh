#!/usr/bin/env bash
# Re-apply the reasoning-passthrough patch to codex-universal-proxy's completion
# adaptor after a proxy (re)install wipes it. Idempotent and safe: only overwrites
# when the installed adaptor is the exact known-unpatched upstream; otherwise warns
# so the patch can be re-derived against a changed upstream. See memory
# ollama-cloud-codex-mcp-proxy. After applying: pm2 restart codex-ollama-proxy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
adp="$(npm root -g)/codex-universal-proxy/adaptor/completion-api-adaptor.js"
[ -f "$adp" ] || { echo "adaptor not found: $adp"; exit 1; }
if grep -q "Reasoning passthrough" "$adp"; then echo "already patched"; exit 0; fi
if cmp -s "$adp" "$here/completion-api-adaptor.orig.js"; then
  cp "$here/completion-api-adaptor.patched.js" "$adp"
  echo "re-applied reasoning patch — now: pm2 restart codex-ollama-proxy"
else
  echo "WARNING: installed adaptor differs from known-orig (proxy updated?) — re-derive the patch, do NOT blind-overwrite."; exit 2
fi
