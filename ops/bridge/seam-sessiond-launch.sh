#!/usr/bin/env bash
# #598: sessiond must outlive the bridge, so it runs as its own supervised app.
# Re-resolve the release on every start: dist/index.js is the symlink the
# rollout updates, and sessiond.js is its sibling inside that release.
set -euo pipefail
NODE="${SEAM_NODE:-$HOME/.nvm/versions/node/v22.22.2/bin/node}"
LINK="$HOME/.seam/seam-acp/packages/bridge/dist/index.js"
REL_DIR="$(dirname "$(readlink -f "$LINK")")"
exec "$NODE" "$REL_DIR/sessiond.js" \
  --socket "$HOME/.seam/sessiond/control.sock" \
  --state  "$HOME/.seam/sessiond/slots.json"
