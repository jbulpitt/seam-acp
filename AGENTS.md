# Agent Instructions for seam-acp

This file contains instructions for AI agents (Copilot, Claude, Gemini, etc.) working inside this repository via Discord.

## What this project is

`seam-acp` is the Discord bot you are currently running inside. It bridges Discord messages to AI agent CLIs via the Agent Client Protocol (ACP). You are likely talking to yourself.

## ⚠️ CRITICAL: Applying code changes or restarting the app

**Never run `pm2 restart seam-acp` directly.** The bot is managed by PM2. A direct restart kills the process immediately — including the agent session running the command — so your reply will never be delivered to Discord.

**Always use:**

```bash
npm run redeploy
```

This is the only safe way to apply code changes or restart the bot. It:
1. Compiles the TypeScript (`npm run build`)
2. Echoes a confirmation so the reply is delivered
3. Restarts the PM2 process 3 seconds later in the background

If you are asked to:
- Apply code changes → run `npm run redeploy`
- Restart the bot → run `npm run redeploy`
- Rebuild the app → run `npm run redeploy`

Do **not** run `pm2 restart`, `pm2 reload`, `npm start`, or any other direct process restart command.

## Useful PM2 commands (read-only / safe)

```bash
pm2 status                      # check if the bot is running
pm2 logs seam-acp               # tail live logs
pm2 logs seam-acp --lines 100   # last 100 log lines
```

## Project structure

- `src/` — TypeScript source
- `dist/` — compiled output (do not edit directly)
- `src/config.ts` — all env var definitions and validation (Zod)
- `src/platforms/discord/` — Discord adapter, orchestrator, and slash commands
- `src/agents/` — agent profile definitions (Copilot, Gemini, Claude)
- `src/core/` — session store, streaming, routing
- `data/` — SQLite database (runtime, not committed)
- `.env` — local environment config (not committed)

## Environment variables

Key variables are defined and validated in `src/config.ts`. Notable ones:

- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to use the bot
- `DISCORD_ALLOWED_CHANNEL_IDS` — optional; restrict the bot to threads in specific parent channels
- `REPOS_ROOT` — root directory the agent can access
- `DEFAULT_AGENT` — which agent profile to use by default (`copilot`, `gemini`, `claude`)

After changing `.env`, run `npm run redeploy` to rebuild and restart.
