# Remote agent profiles

A remote agent profile lets you run an agent CLI (e.g. GitHub Copilot, Claude Code) on a **separate machine** — one that cannot accept inbound connections (e.g. a Mac behind a corporate NAT) — and expose it in seam-acp as a regular `/seam agent` option.

The bridge script (`scripts/remote-agent-bridge.mjs`) runs on the remote machine, spawns the agent CLI, and pipes its ACP stdio over a WebSocket to seam-acp. Two topologies are supported:

| | **Mode A — seam-acp hosts WS server** | **Mode B — remote machine hosts WS server** |
|---|---|---|
| WS server runs on | seam-acp machine | Remote machine |
| `cloudflared` runs on | seam-acp machine | Remote machine |
| Config format | `id:port:token` | `id:wss://url:token` |
| Best for | You control the server; remote is untrusted/mobile | Your Mac stays fixed; server is the client |

Both modes use the same bridge script and the same `REMOTE_COPILOT_PROFILES` env var. Neither side needs an open inbound port — both use Cloudflare Tunnel for an outbound-only connection.

---

## Mode A: seam-acp hosts the WS server

```
Remote machine (Mac)
  └─ bridge (client mode)
       └─ outbound wss:// ──→ Cloudflare edge ←── cloudflared ── seam-acp
                                                                    └─ WS server (port 9999)
```

### 1. Install `cloudflared` on the seam-acp server

```sh
# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# macOS
brew install cloudflare/cloudflare/cloudflared
```

Start a quick tunnel (no account required):

```sh
cloudflared tunnel --url ws://localhost:9999
# → prints wss://random-name.trycloudflare.com
```

For a permanent URL, [create a named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) pointing `agent.yourdomain.com → localhost:9999`.

### 2. Configure seam-acp

```sh
# .env on the seam-acp server
# Format: id:port:token
REMOTE_COPILOT_PROFILES=mac:9999:your-secret-token
```

Run `npm run redeploy` to apply.

### 3. Run the bridge on the remote machine (client mode)

```sh
# From the seam-acp repo directory (ws package already installed):
node scripts/remote-agent-bridge.mjs wss://random-name.trycloudflare.com your-secret-token --cwd /Users/you/Projects

# Or with a permanent domain:
node scripts/remote-agent-bridge.mjs wss://agent.yourdomain.com your-secret-token --cwd /Users/you/Projects
```

---

## Mode B: remote machine hosts the WS server

```
seam-acp
  └─ AgentRuntime
       └─ outbound wss:// ──→ Cloudflare edge ←── cloudflared ── Remote machine (Mac)
                                                                    └─ bridge (server mode)
                                                                         └─ WS server (port 9999)
```

### 1. Install `cloudflared` on the remote machine

```sh
brew install cloudflare/cloudflare/cloudflared
```

### 2. Run the bridge in server mode

```sh
node scripts/remote-agent-bridge.mjs --server 9999 your-secret-token --cwd /Users/you/Projects
# [bridge] Listening on ws://localhost:9999
```

### 3. Start the Cloudflare Tunnel

In a separate terminal on the same machine:

```sh
cloudflared tunnel --url ws://localhost:9999
# → prints wss://random-name.trycloudflare.com
```

### 4. Configure seam-acp

```sh
# .env on the seam-acp server
# Format: id:wss://url:token  (URL must begin with ws:// or wss://)
REMOTE_COPILOT_PROFILES=mac:wss://random-name.trycloudflare.com:your-secret-token
```

Run `npm run redeploy` to apply.

---

## Running a different agent (e.g. claude-agent-acp)

By default the bridge spawns `copilot --acp`. You can point it at any ACP-compatible CLI using env vars:

| Env var | Default | Purpose |
|---|---|---|
| `COPILOT_CMD` | `copilot` | The command (or full path) to spawn |
| `COPILOT_ARGS` | `--acp` | Arguments passed to the command. Set to `""` if the command takes no args. |

### Example: claude-agent-acp

Install Claude Code on the remote machine (official installer):

```sh
curl -fsSL https://claude.ai/install.sh | bash
# → installs to ~/.local/bin/claude
```

Install the ACP adapter:

```sh
npm install -g @agentclientprotocol/claude-agent-acp
```

Start the bridge:

```sh
COPILOT_CMD=claude-agent-acp COPILOT_ARGS="" \
  node scripts/remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com your-token --cwd /Users/you/Projects
```

If `claude-agent-acp` can't find the `claude` binary automatically, point it explicitly:

```sh
COPILOT_CMD=claude-agent-acp COPILOT_ARGS="" CLAUDE_CODE_EXECUTABLE="$HOME/.local/bin/claude" \
  node scripts/remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com your-token --cwd /Users/you/Projects
```

---

## Running as a background service

### PM2 (recommended)

```sh
npm install -g pm2

# Client mode (copilot):
pm2 start scripts/remote-agent-bridge.mjs \
  --name remote-agent-bridge \
  -- wss://agent.yourdomain.com your-secret-token --cwd /Users/you/Projects
pm2 save

# Client mode (claude-agent-acp) — pass env vars via ecosystem config or --env:
pm2 start scripts/remote-agent-bridge.mjs \
  --name remote-agent-bridge \
  --env COPILOT_CMD=claude-agent-acp \
  --env COPILOT_ARGS="" \
  --env CLAUDE_CODE_EXECUTABLE=/Users/you/.local/bin/claude \
  -- wss://agent.yourdomain.com your-secret-token --cwd /Users/you/Projects
pm2 save

# Server mode:
pm2 start scripts/remote-agent-bridge.mjs \
  --name remote-agent-bridge \
  -- --server 9999 your-secret-token --cwd /Users/you/Projects
pm2 save
```

Or use a `ecosystem.config.cjs` on the Mac:

```js
module.exports = {
  apps: [{
    name: "remote-agent-bridge",
    script: "/path/to/seam-acp/scripts/remote-agent-bridge.mjs",
    args: "wss://agent.yourdomain.com your-secret-token --cwd /Users/you/Projects",
    env: {
      COPILOT_CMD: "claude-agent-acp",
      COPILOT_ARGS: "",
      CLAUDE_CODE_EXECUTABLE: "/Users/you/.local/bin/claude",
      // NODE_EXTRA_CA_CERTS: "/path/to/corporate-ca.pem",  // if behind a TLS-inspecting proxy
    },
  }],
};
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.seam.remote-agent-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.seam.remote-agent-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/seam-acp/scripts/remote-agent-bridge.mjs</string>
    <!-- client mode: -->
    <string>wss://agent.yourdomain.com</string>
    <string>your-secret-token</string>
    <string>--cwd</string>
    <string>/Users/you/Projects</string>
    <!-- server mode: replace the three lines above with:
    <string>- -server</string>
    <string>9999</string>
    <string>your-secret-token</string>
    -->
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COPILOT_CMD</key>
    <string>claude-agent-acp</string>
    <key>COPILOT_ARGS</key>
    <string></string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/remote-agent-bridge.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.seam.remote-agent-bridge.plist
```

---

## Multiple remote profiles

You can mix both modes in the same env var (comma-separated):

```sh
REMOTE_COPILOT_PROFILES=mac:wss://mac.trycloudflare.com:token-a,workstation:9998:token-b
```

Each entry becomes an independent agent profile in `/seam agent`. Run a separate bridge instance per machine.

---

## Resilience behaviour

The bridge and seam-acp are designed to survive disconnects automatically:

- **Keepalive pings** — both sides ping every 25 s to prevent idle-connection drops from Cloudflare Tunnel or corporate proxies.
- **Automatic reconnect** — the bridge reconnects after 5 s on disconnect. seam-acp waits up to 44 s for the bridge to reconnect before surfacing an error.
- **Grace period** — on an abnormal close, seam-acp holds the agent process for 20 s. If the bridge reconnects within that window, the session resumes immediately with no user-visible interruption.
- **Session restore** — if the bridge stays disconnected longer than the grace period (or the agent process exits), seam-acp attempts to restore the session from disk on the next message using the ACP `session/load` call. If that fails, a new session is started transparently and the turn is retried — the user never sees an error.

---

## Corporate proxy / TLS inspection

If the agent CLI makes HTTPS calls through a TLS-inspecting proxy (e.g. Zscaler), you may see certificate errors. Set `NODE_EXTRA_CA_CERTS` to the proxy's root CA certificate:

```sh
# Find the Zscaler cert in the system keychain on macOS:
security find-certificate -c "Zscaler Root CA" -p /Library/Keychains/System.keychain > ~/zscaler-ca.pem

# Pass it to the bridge (and child processes inherit it):
NODE_EXTRA_CA_CERTS=~/zscaler-ca.pem \
  node scripts/remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com your-token --cwd /Users/you/Projects
```

Add `NODE_EXTRA_CA_CERTS` to the PM2 env or launchd `EnvironmentVariables` to make it permanent.

---

## Security notes

- Use `wss://` (TLS) in production. Cloudflare Tunnel always terminates TLS at the edge.
- Tokens are stored in `.env` — keep that file out of version control (it is in `.gitignore`).
- Authentication uses `Authorization: Bearer <token>` during the HTTP upgrade handshake. Connections with a missing or wrong token are rejected before any data is exchanged (close code `4001`).
- In server mode, the WS port is bound to `0.0.0.0`. If you're using Cloudflare Tunnel you can tighten this to `127.0.0.1` by modifying the bind address in `makeRemoteCopilotServerProfile` in `src/agents/profiles/remote.ts`.
- In client mode, the token must not contain colons (it is the segment after the last `:` in the config value).

---

## Limitations

- **No `/seam whoami` support.** Remote profiles always return unknown — the agent's local config files are not readable from the seam-acp host.
- **Agent CLI must be pre-authenticated.** Run `copilot auth login` (or `claude /login`) on the remote machine before starting the bridge.
- **One agent process per bridge.** A single bridge connection can serve multiple concurrent Discord threads (ACP supports multiple sessions per process). Run a separate bridge instance if you want separate agent processes.

