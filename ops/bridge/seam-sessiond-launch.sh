#!/usr/bin/env bash
# #598: sessiond must outlive the bridge, so it runs as its own supervised app.
# Re-resolve the release on every start: dist/index.js is the symlink the
# rollout updates, and sessiond.js is its sibling inside that release.
set -euo pipefail
NODE="${SEAM_NODE:-$HOME/.nvm/versions/node/v22.22.2/bin/node}"
LINK="$HOME/.seam/seam-acp/packages/bridge/dist/index.js"
exec "$NODE" --input-type=module - "$LINK" <<'SEAM_SESSIOND_LAUNCH'
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = path.dirname(realpathSync(process.argv[2]));
await import(pathToFileURL(path.join(directory, 'load-bridge-config.js')).href);
const node = process.env.SEAM_NODE || process.execPath;
process.execve(node, [node, path.join(directory, 'sessiond.js')], process.env);
SEAM_SESSIOND_LAUNCH
