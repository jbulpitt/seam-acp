#!/usr/bin/env bash
# Wrapper for cloudflared quick tunnel.
# Captures the trycloudflare.com URL as soon as cloudflared announces it
# and writes it as a wss:// URL to data/tunnel-url.txt so seam-acp can
# publish it to the discovery gist.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/home/ubuntu/Projects/seam-acp/data}"
mkdir -p "$DATA_DIR"
URL_FILE="$DATA_DIR/tunnel-url.txt"

cloudflared tunnel --url http://localhost:9999 2>&1 | while IFS= read -r line; do
  # Echo every line so pm2 logs capture it normally.
  echo "$line"
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    ws_url="${BASH_REMATCH[1]/https:\/\//wss://}"
    echo "$ws_url" > "$URL_FILE"
    echo "[cloudflared-wrapper] Wrote tunnel URL: $ws_url"
  fi
done
