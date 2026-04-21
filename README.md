# seam-acp

A bridge between chat platforms (Discord today, Slack tomorrow) and ACP-compatible coding agents (GitHub Copilot today, Claude Code / others tomorrow).

> **Status:** v0 — feature parity with the C# `copilot-discord-bot` complete. Multi-platform / multi-agent abstractions baked in from day one; only Discord + Copilot are implemented today.

## What it does

- Run a chat bot on a server / home lab / VM.
- From your phone (Discord), spin up a session per thread.
- Pick a repo with emoji reactions; chat with a coding agent in the thread.
- Switch model on the fly. Switch mode (Agent / Plan / Autopilot). Switch agent (later).

## Why ACP

The [Agent Client Protocol](https://agentclientprotocol.com) is the LSP-equivalent for coding agents. Picking ACP means:

- The agent integration is a typed protocol, not a vendor SDK.
- Switching to a different ACP-compatible agent is a config change, not a rewrite.
- We get streaming updates, mode switching, and live model switching as first-class features.

## Configure

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | From the Discord developer portal |
| `DISCORD_ALLOWED_USER_IDS` | yes | Comma-separated Discord user IDs that can control the bot (e.g. `123,456`) |
| `DISCORD_DEV_GUILD_ID` | no | Set to register slash commands instantly to one guild (good for dev) |
| `REPOS_ROOT` | yes | Root folder containing repos the agent can touch |
| `DATA_DIR` | no | Defaults to `./data` (sqlite lives here) |
| `DEFAULT_AGENT` | no | `copilot` for now |
| `DEFAULT_MODEL` | no | e.g. `gpt-5.4`, `claude-sonnet-4.5`, `claude-opus-4.7`, `auto` |
| `COPILOT_CLI_PATH` | no | If `copilot` is not on `PATH` |
| `TURN_TIMEOUT_SECONDS` | no | Default 900 |
| `LOG_LEVEL` | no | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `HEALTH_PORT` | no | Default 3000 — exposes `GET /health` |
| `DEFAULT_AUTO_APPROVE` | no | `false` (safe default) — set `true` to auto-approve all agent permission requests bot-wide. Override per-session with `/seam approve`. |

You also need the GitHub Copilot CLI installed locally (`brew install github/gh/copilot` or `npm i -g @github/copilot`) and authenticated (`copilot auth login`). The Docker image installs and runs the CLI for you, but you still need to mount auth state or sign in inside the container.

## Run (local dev)

```sh
npm install
cp .env.example .env   # then edit
npm run dev
```

The bot starts, registers `/seam` slash commands (guild-scoped if `DISCORD_DEV_GUILD_ID` is set, global otherwise — global takes up to an hour to propagate), and exposes `GET /health` on `HEALTH_PORT`.

## Run (Docker)

```sh
docker compose up -d --build
```

Pass `--build-arg INSTALL_COPILOT_CLI=false` if you want to mount your own Copilot CLI binary.

## Slash commands

All commands are restricted to users listed in `DISCORD_ALLOWED_USER_IDS` and (where it matters) thread-scoped.

| Command | What it does |
|---|---|
| `/seam new [name]` | Create a new public thread in the current channel |
| `/seam init` | Bind the current thread as a session and post the repo picker |
| `/seam repo <path>` | Set the working repo (relative to `REPOS_ROOT` or absolute under it) |
| `/seam repos` | List repos found under `REPOS_ROOT` |
| `/seam model [id]` | Get / set the model for this session (live if a runtime is active) |
| `/seam mode <id>` | Set the agent operational mode (e.g. plan / agent / autopilot) |
| `/seam effort <low\|medium\|high>` | Set reasoning effort (model-dependent) |
| `/seam tools <allow\|exclude> [csv]` | Tool allow / exclude list (empty list = clear) |
| `/seam approve <ask\|always>` | Permission policy. `always` auto-approves all tool permission requests; `ask` denies them (safe default). |
| `/seam abort` | Cancel the in-flight turn |
| `/seam config` | Show the session config JSON |
| `/seam config-set <json>` | Replace the session config wholesale |
| `/seam sessions` | List recent sessions across the bot |
| `/seam help` | Show this list |

Free-form messages in a thread are sent straight to the agent.

## Architecture

```
ChatAdapter          (Discord today, Slack tomorrow)
   ↓
Orchestrator   ──→   Renderer  (platform-specific text formatting)
   ↓
SessionRouter  ──→   SessionStore  (sqlite via better-sqlite3)
   ↓
AgentRuntime         (one per session; auto-resumes on restart)
   ↓
AgentProfile         (Copilot today, Claude Code tomorrow — adds via `src/agents/profiles/`)
```

- **`src/platforms/chat-adapter.ts`** — generic chat platform interface.
- **`src/platforms/discord/`** — discord.js v14 implementation + slash commands + repo picker.
- **`src/agents/agent-runtime.ts`** — wraps `@agentclientprotocol/sdk` + a child process running an ACP server. Handles `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, model / mode / config option setters, and emits typed events.
- **`src/agents/profiles/copilot.ts`** — spawns `copilot --acp`. Add a sibling for any other ACP-compatible agent.
- **`src/core/`** — pure utilities: text chunker, path safety, sqlite store, session router, status panel.

## Testing

```sh
npm test         # 30 unit tests + 1 integration test against `copilot --acp`
npm run typecheck
npm run build
```

The ACP integration test is automatically skipped if `copilot` is not on `PATH`.

## License

MIT — see [LICENSE](LICENSE).
