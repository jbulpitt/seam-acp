# Remote agent profiles

A remote agent profile lets you run an agent CLI (e.g. GitHub Copilot) on a **separate machine** — one that cannot accept inbound connections — and expose it inside seam-acp as a regular `/seam agent` option.

The use case this was designed for: a Mac laptop that has Copilot CLI authenticated under a personal account, sitting behind a corporate NAT, that can make **outbound** connections but cannot be SSH'd into.

## How it works

```
Mac (Copilot CLI)
  └─ bridge script
       └─ outbound WebSocket ──→ seam-acp WS server (port 9999)
                                      │
                               AgentRuntime
                               (ndjson over WS, same as local stdio)
```

1. seam-acp starts a WebSocket server on a configurable local port.
2. The **bridge script** (`scripts/remote-agent-bridge.mjs`) runs on the Mac. It connects outbound to the WebSocket server and spawns `copilot --acp` locally, piping its stdio over the socket.
3. seam-acp treats the resulting byte stream identically to a locally spawned process — no changes to AgentRuntime or the ACP protocol.

The remote profile appears in `/seam agent` like any other profile. If the bridge disconnects, the next spawn attempt waits up to ~44 seconds for a new connection, then surfaces a clear error.

## Recommended network setup (Cloudflare Tunnel)

The WebSocket server port only needs to be reachable by the bridge — it does **not** need to be open on the public internet, and seam-acp does not need any inbound ports at all.

The cleanest way to expose it without opening firewall ports on either side is a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```
Mac ──outbound HTTPS──→ Cloudflare edge ←──outbound tunnel── seam-acp server
```

Both sides connect **outbound** to Cloudflare. Neither machine needs an inbound port.

### 1. Install and run `cloudflared` on the seam-acp server

```sh
# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
```

Start a quick tunnel (no account required for testing):

```sh
cloudflared tunnel --url ws://localhost:9999
```

Cloudflare prints a temporary URL like `wss://random-name.trycloudflare.com`. For a permanent URL, [create a named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) pointing `agent.yourdomain.com → localhost:9999`.

### 2. Configure seam-acp

Add to `.env`:

```sh
# Format: id:port:token  (comma-separate multiple entries)
REMOTE_COPILOT_PROFILES=mac:9999:your-secret-token
```

- **id** — unique name for this profile (appears as `copilot-remote-mac` in `/seam agent`)
- **port** — local TCP port the WebSocket server listens on
- **token** — shared secret; the bridge must present this as `Authorization: Bearer <token>`

Run `npm run redeploy` to apply the change.

### 3. Run the bridge script on the Mac

The bridge script lives in `scripts/remote-agent-bridge.mjs` in this repo. Copy it to the Mac, or clone the repo there.

Install its only dependency:

```sh
npm install ws
```

Then start the bridge:

```sh
node scripts/remote-agent-bridge.mjs wss://random-name.trycloudflare.com your-secret-token
# or with a permanent domain:
node scripts/remote-agent-bridge.mjs wss://agent.yourdomain.com your-secret-token
```

The bridge automatically reconnects on disconnect. You can run it as a background service (launchd on macOS, or `pm2` if Node is available):

```sh
# Keep running in background with pm2 (optional)
npm install -g pm2
pm2 start scripts/remote-agent-bridge.mjs \
  --name copilot-bridge \
  -- wss://agent.yourdomain.com your-secret-token
pm2 save
```

If `copilot` is not on `PATH`, pass the binary path as a third argument or set `COPILOT_CMD`:

```sh
COPILOT_CMD=/opt/homebrew/bin/copilot \
  node scripts/remote-agent-bridge.mjs wss://agent.yourdomain.com your-secret-token
```

## Multiple remote profiles

You can register multiple remote profiles pointing to different ports and/or different machines:

```sh
REMOTE_COPILOT_PROFILES=mac:9999:token-a,workstation:9998:token-b
```

Each becomes an independent agent profile (`copilot-remote-mac`, `copilot-remote-workstation`) and runs its own WebSocket server. Run a separate bridge instance per machine.

## Security notes

- Tokens are transmitted over TLS when using `wss://` (Cloudflare Tunnel always uses TLS). Do not use `ws://` over the public internet.
- Tokens are stored in `.env` — keep that file out of version control (it's in `.gitignore`).
- The WebSocket port is bound to all interfaces by default (`0.0.0.0`). If you're using Cloudflare Tunnel you can tighten this to `127.0.0.1` by setting `WS_HOST=127.0.0.1` — though this is not yet a config option and would require a small code change.
- Connections are authenticated via `Authorization: Bearer <token>` during the HTTP upgrade handshake. Connections with a missing or wrong token are rejected before any data is exchanged.

## Limitations

- **No `whoami` support.** The remote profile always returns `null` for `/seam whoami` because it cannot read the CLI's local config files from the seam-acp host.
- **Agent CLI must be pre-authenticated.** The bridge just spawns `copilot --acp` — you need to run `copilot auth login` on the Mac beforehand.
- **One copilot process per bridge connection.** ACP supports multiple sessions per process, so a single bridge connection can serve multiple concurrent Discord threads. However, if the bridge is not connected, new sessions will queue for up to ~44 seconds before timing out.
