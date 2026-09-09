#!/bin/sh
set -eu

printf '%s\n' "scripts/restart-bridge.sh is retired: its hard-coded PM2 identity was unsafe."
printf '%s\n' "Run a read-only mapped preflight instead:"
printf '%s\n' "  npm run bridge:rollout -- --target media-server"
printf '%s\n' "  npm run bridge:rollout -- --target macbook-air"
printf '%s\n' "See docs/bridge-rollout.md for staged activation and explicit rollback."
exit 1
