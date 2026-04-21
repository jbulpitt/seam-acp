# seam-acp

A bridge between chat platforms (Discord today, Slack tomorrow) and ACP-compatible coding agents (GitHub Copilot today, Claude Code / others tomorrow).

> **Status: pre-alpha.** Phase 1 of 6 (scaffold).

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
| `DISCORD_OWNER_USER_ID` | yes | Only this user can control the bot |
| `REPOS_ROOT` | yes | Root folder containing repos the agent can touch |
| `DATA_DIR` | no | Defaults to `./data` |
| `DEFAULT_AGENT` | no | `copilot` for now |
| `DEFAULT_MODEL` | no | e.g. `gpt-5.4`, `claude-sonnet-4.5`, `auto` |
| `COPILOT_CLI_PATH` | no | If `copilot` is not on `PATH` |
| `TURN_TIMEOUT_SECONDS` | no | Default 900 |
| `HEALTH_PORT` | no | Default 3000 |

## Run (local dev)

```sh
npm install
cp .env.example .env   # then edit
npm run dev
```

## Run (Docker)

```sh
docker compose up -d --build
```

## Architecture

Three abstractions, all real from day one:

```
ChatAdapter          (Discord today, Slack tomorrow)
   ↓
SessionRouter ─── SessionStore (sqlite)
   ↓
AgentRuntime         (one per thread)
   ↓
AgentProfile         (Copilot today, Claude Code tomorrow)
```

See [docs/architecture.md](docs/architecture.md) (TODO).

## License

TBD.
