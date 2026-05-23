#!/usr/bin/env bash
# Gracefully restarts the remote-agent-bridge via PM2.
# Sends SIGUSR2 to put the bridge in drain mode (waits for active turns to finish),
# then PM2 auto-restarts it once the process exits.
PID_FILE="$HOME/.pm2/pids/remote-agent-bridge-2.pid"
PID=$(cat "$PID_FILE" 2>/dev/null)
if [[ -z "$PID" ]]; then
  echo "Bridge PID not found at $PID_FILE — trying pm2 restart..."
  pm2 restart remote-agent-bridge
  exit 0
fi
echo "Sending SIGUSR2 to bridge PID $PID (drain mode)..."
kill -USR2 "$PID"
echo "Bridge will exit once active turns complete. PM2 will restart it automatically."
echo "Watch progress with: pm2 logs remote-agent-bridge"
