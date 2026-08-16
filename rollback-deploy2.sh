#!/usr/bin/env bash
# Roll back the seam-MCP feature deploy (main @ f91b054 + SEAM_MCP_ENABLED).
# Restores the exact pre-deploy binary + disables the MCP server, then restarts.
# `pm2 restart` is intentional here — in a rollback the bot is already down, so
# there is no in-flight reply to protect.
set -eux
cd /home/ubuntu/Projects/seam-acp

# 1) Restore the pre-deploy build (the binary prod was actually running).
if [ -d dist.bak.predeploy2 ]; then
  rm -rf dist
  cp -r dist.bak.predeploy2 dist
fi

# 2) Disable the seam-MCP server (revert the .env addition).
sed -i '/^SEAM_MCP_ENABLED=/d' .env

# 3) Restart.
pm2 restart seam-acp

set +x
echo
echo "Rolled back. Confirm it came up:"
echo "  pm2 logs seam-acp --lines 40 --nostream   # look for 'seam-acp ready'"
