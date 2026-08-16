#!/usr/bin/env bash
# seam-mcp deploy rollback — restore the pre-deploy state and restart.
#
# Pre-deploy state: branch fix/agy-concurrent-turn-discovery-race @ 4ab5c5c,
# with the exact running binary backed up at dist.bak.predeploy.
#
# NOTE: this uses `pm2 restart` directly. That is normally forbidden (it kills
# an in-flight agent reply) — but in a rollback the bot is already down/broken,
# so there is no reply to protect and a direct restart is the right recovery.
set -eux
cd /home/ubuntu/Projects/seam-acp

# 1) Put the source back on the pre-deploy branch.
git checkout fix/agy-concurrent-turn-discovery-race

# 2) Restore the exact pre-deploy build (instant — no rebuild needed).
if [ -d dist.bak.predeploy ]; then
  rm -rf dist
  cp -r dist.bak.predeploy dist
else
  npm run build
fi

# 3) Restart the process (direct is OK here — the bot is already down).
pm2 restart seam-acp

set +x
echo
echo "Rollback complete. Confirm it came back with:"
echo "  pm2 logs seam-acp --lines 40 --nostream   # look for 'seam-acp ready'"
