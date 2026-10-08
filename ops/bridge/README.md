# Remote bridge hosts

Every bridge instance keeps its settings in **one file**, `~/.config/seam/bridge.env`
(mode `0600`), which the bridge reads itself at startup (#618). The supervisor —
pm2 or systemd — only runs a command. Keys in the file replace the same keys
from the supervisor, so a pm2 dump can never reinstate a removed setting.

A second bridge on the same host (for example staging) sets
`SEAM_BRIDGE_CONFIG_PATH` to its own file in both its bridge and sessiond
launches. It must not load the production default. Keep that instance's
socket, state and resume directory in its file too.

The channel-gated `host_exec`, `host_push`, and `host_pull` agent tools use the
bridge command and attachment RPCs. Paths are not workspace-jailed; the bridge
process user's OS permissions and the attachment size cap are the limits.

The bridge's first log line says what it loaded:

```
[bridge] config: /home/operator/.config/seam/bridge.env set 14 keys: AGY_ENABLED, AGY_PIN, ..., SEAM_BRIDGE_TOKEN
```

Key names only; values (the token) are never logged.

## Files

| File | Installed at |
|---|---|
| `bridge.env.example` | `~/.config/seam/bridge.env` (fill in, `chmod 600`) |
| `seam-bridge-launch.mjs` | `~/.local/libexec/seam-bridge-launch.mjs` (systemd hosts) |
| `seam-sessiond-launch.sh` | `~/.local/libexec/seam-sessiond-launch.sh` |
| `seam-bridge.service`, `seam-sessiond.service` | `/etc/systemd/system/` (systemd hosts) |
| `ecosystem.config.cjs` | anywhere; pm2 hosts start both apps from it |

sessiond runs as its own unit/app so agent children survive a bridge restart (#598).
Each slot's child runs under its own slot holder, so restarting sessiond
itself (to update it) leaves running turns alone: the new sessiond reconnects
to every holder (#631). Its unit uses `KillMode=process` and the pm2 app
`treekill: false` for that reason; keep them.
The daemon launcher reads the same file, including `SEAM_NODE` and the
`SEAM_SESSIOND_SOCKET`, `SEAM_SESSIOND_STATE`, and `SEAM_SESSIOND_RESUME_DIR`
settings. It resolves the active release with Node on Linux and macOS.

## Migrating a host

1. Build the file from what the host **actually runs**, not from a key list:
   the live bridge's environment (`/proc/<pid>/environ`) plus the host's existing
   config (ecosystem file, `EnvironmentFile=`, launcher). Keep every agent key,
   `PATH`, the `SEAM_BRIDGE_*` connection keys, and any secret a project
   `.mcp.json` references (`SENTRY_TOKEN`, `LANGFUSE_MCP_AUTH`, …). Dropping those
   silently disables that project's MCP servers.
2. pm2: `pm2 delete seam-bridge && pm2 start ecosystem.config.cjs --only seam-bridge && pm2 save`.
   `pm2 restart --update-env` merges and cannot remove a key — never use it for config changes.
   Include the shipped `seam-sessiond` app with `treekill: false`. When an old
   daemon lacks that setting, signal its exact main PID with SIGTERM, not
   `pm2 restart`: PM2's tree kill would kill the holders too. Installing or
   replacing the daemon app needs an operator-reviewed migration for the
   installed PM2 version: a supervised app can respawn while it is being
   replaced. Verify `treekill: false` on the live app before any PM2 stop or
   delete. Keep the holders running throughout.
3. systemd: install the shipped launcher, remove any `EnvironmentFile=` drop-in, `daemon-reload`, restart.
4. Verify:
   - the `[bridge] config:` line lists the keys you expect;
   - the controller's `bridge reconciled` journal line for the host lists the same agents as before;
   - the bridge log has no `unresolved environment variables; skipping this server` for a project that uses those servers;
   - `npm run bridge:rollout -- --target <host>` reports `rollout_ready=yes`.
