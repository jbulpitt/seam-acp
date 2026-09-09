#!/bin/sh
# This fixed shell is streamed over SSH. Every deployment identity value is
# supplied from the reviewed target map; no remote shell fragment is accepted.
set -eu

node_path=${1:-}
shift || exit 64
case "$node_path" in /*) ;; *) printf 'error=invalid_node_path\n' >&2; exit 64 ;; esac
test -x "$node_path" || { printf 'error=configured_node_missing\n' >&2; exit 69; }

exec "$node_path" --input-type=module - "$@" <<'SEAM_REMOTE_NODE'
__SEAM_BRIDGE_ROLLOUT_NODE_PROGRAM__
SEAM_REMOTE_NODE
