# Agent Instructions for seam-acp

This file contains instructions for AI agents (Copilot, Claude, Gemini, etc.) working inside this repository via Discord.

## What this project is

`seam-acp` is the Discord bot you are currently running inside. It bridges Discord messages to AI agent CLIs via the Agent Client Protocol (ACP). You are likely talking to yourself.

## Output formatting

Your output is streamed to Discord, which does **not** support markdown tables. Avoid using tables in your responses — they render as garbled text. Use bullet lists, bold labels, or plain text instead.

## Dogfood these while pairing here

You are developing the bot you are running in. Use the product instead of
prose workarounds, native ACP tools that do not fire over this bridge, or
hand-editing runtime state.

- **A pick from Jesse** (approve, which plan, ship vs wait): frozen click-card
  **in this thread**. MCP `create_choice` or a `seam-choice` fence. Default is
  live, one person, one pick — the card shows the selection and buttons go
  away. Do not ask him to type "1 or 2". **Several of N at once** ("which of
  these should I work on?"): add `select: { min, max }` — the card becomes a
  dropdown + Confirm and returns **one combined prompt** with just his picks;
  don't ask him to list numbers. Protocol:
  `docs/agent-guides/interactive-prompts.md`. `maxClicks` > 1 only when several
  people should each click (not combinable with `select`). Participants click;
  they do not author.
- **Gemini in a voice channel (live help):** MCP `create_live_help` (no fence)
  after packing `system` + optional `historySummary`. `voiceChannelId`: this
  thread’s rider first, else family-guild General. Students may *be in* the
  VC and may ask their course agent to start or stop their own session; no
  parent/admin approval is required. How-to:
  `docs/agent-guides/live-help.md`. School overlays:
  `docs/agent-guides/live-help-onboarding.md`. Not TTS, not STT, not Go Live.
- **A file he should open:** `seam-attach` fence (path only), not a path in prose.
- **Another thread in this channel:** `threads()` first. Idle → `handoff` /
  `forward`. Busy → `send` (inbox; they `poll_inbox`). Set `returnTo` to that
  thread when he does not want a report-back here. Never hand off to `isSelf`.
- **Find or read prior conversation:** `search_messages` searches your thread,
  selected siblings, or all threads in this channel and returns message-id
  anchors; `read_messages` loads latest / around / before / after context,
  including cards. Those two live reads never cross channels. `peek(thread,
  count?)` shares their reader but retains cross-channel recent-N reach by raw
  Discord thread id, including threads without a Seam session.
- **Reconfigure or reset another thread's session** (not just message it):
  `configure_thread(thread, { agent?, model?, effort?, role?, disableThreadPrefix?, fastMode?, rebuild? })`
  changes its agent / model / effort / naming role and reports what actually
  reset (agent switch always resets; model switch resets on codex, and on
  ollama-cloud when that agent is enabled, not claude; effort never does);
  `rebuild: true` then performs deterministic Discord reconstruction in the
  target thread and may be used without another config change;
  `reset_thread_session(thread)` clears its context
  but keeps the model. Same in-channel scope as `handoff`.
- **`role` is what a thread is for, not how it runs:** a free-form label
  (`worker`, `qa`, `orchestrator`, …) that is a first-class config dimension
  beside agent/model/effort. It drives the role symbol in the thread name and
  groups threads for enumeration. Thread names are maintained by Seam from
  agent + model + role + ordinal — **do not hand-rename a thread to fix its
  prefix**; set the identity and the name follows.
- **Migrate your own thread to a new brain and keep working:**
  `migrate_self({ agent?, model?, effort?, manifest, rebuild? })` stages an
  agent/model switch until your current turn ends. Default: the manifest is
  the replacement session's first prompt. `rebuild: true` applies the switch,
  rebuilds this thread from Discord history (60% of the destination window),
  then fires the manifest as the **next live turn** (the reconstruction seed
  is not the manifest). Self-only; at least one of agent/model must change.
  Rebuild failure rolls the prior agent/model/ACP session back and does not
  fire the manifest.
- **Pick a model by cost or capability:** `model_value_rankings({ tier?, benchmark? })`
  ranks the Copilot catalog by value (AA benchmark ÷ Copilot token cost) within
  flagship / balanced / flash tiers; `model_metadata_query` / `model_metadata_get`
  give provider-agnostic benchmarks, pricing, and context for any
  agent's models. Cache-backed, instant. Check an agent's headroom first with
  `agent_quota({ agentId })`. Detail:
  `docs/agent-guides/model-intelligence-and-thread-control.md`.
- **Wake me later:** `schedule_wake` (or `seam-wake` fence). Native
  `ScheduleWakeup` / `Monitor` emit nothing after `end_turn` here.
- **Wait until a condition:** `watch_create` (file / http / command). Do not
  spin a `schedule_wake` loop that only reports "not yet".
- **Park the next prompt without aborting this turn:** `/seam queue prompt:…`
  (slash; does not cancel the live turn).
- **Rename / move a project folder:** `npm run relocate-repo -- --from <old>
  --to <new>` (dry-run), then `--apply --move --vendor`. Do not hand-edit
  `sessions.repo_path` or `channel-presets.json` cwd. Leftover `--symlink` is
  optional; the repo picker skips symlink dirs. Successful `--apply` writes a
  **force** restart sentinel (SIGTERM live turns; turn-resume continues).
  `npm run redeploy` is the drain-style restart for code changes.
- **Is the upstream down, or is it us?** MCP `service_status` — cached, instant,
  no network. Check it *before* debugging Seam when agent calls start failing.
  Read the two axes separately: `reportedStatus` is what the provider said,
  `observation.health` is whether Seam can currently reach it, so "we cannot
  tell" never reads as "it is fine". `service_status_refresh` forces a bounded
  live re-check and waits for it; parallel callers share one fetch and a repeat
  call inside the cooldown returns `rate_limited`. Only registered source ids
  are accepted — no URL or credential argument exists. How-to:
  `docs/agent-guides/service-status.md`.
- **Git worktrees:** `wt` only — see Git worktrees below.

`poll_inbox` at the start of a turn (and at checkpoints). Empty is normal.

## How a turn runs

```
Discord ─ controller (seam-acp.service) ─ws─ bridge (one per host) ─ sessiond ─ adapter-child ─ agent CLI (ACP)
```

- **controller:** Discord, orchestration, persistence. It is redeployed often.
- **bridge:** one per host, including this one (`seam-local-bridge`). It is restarted on rollouts.
- **sessiond:** a small, stable daemon that owns every agent process and retains its output. **It exists so that a running turn never has to die because the controller or bridge restarted, or the network dropped.** It rarely changes, on purpose.

## How we build here

These are the defaults. When in doubt, choose the one that keeps the user's work moving.

1. **Seam's own lifecycle never ends a turn.** A turn ends only when the user cancels it or the agent exits. Redeploys (including `redeploy:now`), bridge restarts, reconnects, reconciliation, and network loss *detach* and later *re-attach*. They never kill. If you find code that kills a slot for any other reason, that code is the bug.
2. **Recover; don't give up.** When something breaks, the next step is to reconnect, retry, respawn and reload the session, or rebuild. Keep trying for as long as the cause could plausibly clear. For a lost bridge or network that means 15 minutes, which covers a host reboot. The user sees `Reconnecting to session…`, not a failure. Stopping is for causes that can't clear, like an agent that isn't installed, and even then only that one operation stops.
3. **Errors carry their real cause.** Pass the underlying error through. Never swap it for a generic one, and never swallow it into "retained" or a log line nobody reads. If the provider CLI would reject something (an unknown model id, bad input), let it; don't pre-refuse from a cache that may be stale.
4. **Add a check only for a failure you have seen.** A new guard, retry, state, quarantine, or refusal needs an observed failure behind it; name it in the PR description. "It could happen" isn't enough. Prefer deleting a mechanism to adding one around it.
5. **Keep comments short.** Say what the code does and why, briefly. Incident narratives and issue-number chains belong in the PR or issue, not the source; agents copy whatever style they see.
6. **Done means it ran on the real host.** Tests that restate the implementation are not evidence. Run the real path (a real turn, a real restart) and say what you didn't check.

Reviewing? Read `docs/agent-guides/review-guide.md`. It covers the delete-first questions, the outcome ranking that code comments cite as "blast radius", and what to do with an empty review.

## ⚠️ CRITICAL: Applying code changes or restarting the app

Production now runs Seam and the shared Pronoa Playwright MCP as separate
native systemd services:

- `seam-acp.service` — the Discord bot and agent subprocesses
- `pronoa-playwright-mcp.service` — Playwright/Chromium, with its own cgroup
  memory limits and lower CPU/I/O priority
- `pm2-ubuntu.service` — remaining helper processes only; it has
  `OOMPolicy=continue`

The checked-in units and recovery procedure live in `ops/systemd/README.md`.

**Never run `systemctl restart seam-acp` or `pm2 restart seam-acp` directly.**
A direct supervisor restart kills the process immediately — including the agent
session running the command — so your reply will never be delivered to Discord.

**Always use:**

```bash
npm run redeploy
```

This is the only safe way to apply code changes or restart the bot. It:
1. Compiles the TypeScript (`npm run build`)
2. Echoes a confirmation so the reply is delivered
3. Lets the running process drain admitted work
4. Signals Seam with SIGTERM after the drain
5. Lets `seam-acp.service` restart it under systemd

If you are asked to:
- Apply code changes → run `npm run redeploy`
- Restart the bot → run `npm run redeploy`
- Rebuild the app → run `npm run redeploy`

Do **not** run `systemctl restart seam-acp`, `pm2 restart`, `pm2 reload`,
`npm start`, or any other direct process restart command from an agent turn.
`sudo systemctl restart seam-acp` is an interruption-capable emergency command
for a human over SSH, not the normal deployment path.

## Useful systemd commands (read-only / safe)

```bash
systemctl status seam-acp --no-pager
journalctl -u seam-acp -f
journalctl -u seam-acp -n 100 --no-pager
systemctl status pronoa-playwright-mcp --no-pager
journalctl -u pronoa-playwright-mcp -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health
systemctl status seam-local-bridge seam-sessiond --no-pager
sudo journalctl -u seam-local-bridge -n 100 --no-pager
```

`journalctl` for these units needs `sudo`; an empty result without it is a
permissions issue, not a quiet log. Restarting `seam-local-bridge` leaves
running turns alone (sessiond holds them). Remote bridges are updated with
`npm run bridge:rollout -- --target <host>` (dry run), then add
`--rollout --apply` to apply; see `docs/bridge-rollout.md`.

An unauthenticated `http://127.0.0.1:8766/mcp` probe returns HTTP 403 when the
Playwright listener is healthy. Restarting that service interrupts active
browser sessions but does not restart Seam.

Do not use raw `pm2 jlist`, `pm2 prettylist`, or `pm2 env` in streamed agent
output: PM2 embeds application environment variables and may expose secrets.
Use `pm2 ls --no-color`, narrowly scoped `systemctl show`, or process/cgroup
inspection instead.

## Project structure

- `packages/adapters/src/` — ACP process/session infrastructure and agent profiles
- `packages/core/src/` — Discord adapter, orchestration, persistence, workflows,
  MCP, voice, status, and configuration
- `packages/bridge/src/` — the per-host bridge, sessiond, and adapter-child
- `ops/bridge/` — bridge/sessiond units, launcher, and per-host config (`~/.config/seam/bridge.env`)
- `packages/*/dist/` — compiled output (do not edit directly)
- `ops/systemd/` — production units, PM2 OOM-policy drop-in, and operations runbook
- `data/` — SQLite database (runtime, not committed)
- `.env` — local environment config (not committed)

## Testing safety

`npm test` is the bounded non-live suite. It excludes every
`**/*.int.test.ts` file even when provider CLIs are installed. Run
`npm run test:int` only with explicit authorization for potentially billable
live provider requests, and report live results separately from non-live
file/test counts.

## Git worktrees

Use this host's `wt` CLI only (`~/.local/bin/wt`). Do **not** call `git worktree add` / `git worktree remove --force`, symlink `node_modules`, `npm install` a second copy to satisfy a bundler, park trees under `/tmp` or as visible `~/Projects/<name>` siblings, or invent a project-local worktree helper. This repo has no provisioner — call `wt` directly.

Layout: `~/Projects/.worktrees/seam-acp/<name>/`. Bind-mount `node_modules` from the main checkout (never symlink). Teardown unmounts first — a force-remove of a still-mounted `node_modules` deletes the main install. After reboot: `wt bind-all --repo /home/ubuntu/Projects/seam-acp`.

Create with `wt create --repo <checkout> --name <name> --branch <b> --from origin/main`; tear down with `wt teardown <name> --repo <checkout>`. Load `~/.local/share/wt-helpers/AGENTS.md` before creating or tearing down a tree. If `wt` is missing, run `~/.local/share/wt-helpers/install.sh` then `wt doctor`.

## Reference guides (open when relevant)

- Slash commands, and the 8,000-character Discord budget: `docs/agent-guides/slash-commands.md`
- Interactive prompts and cards: `docs/agent-guides/interactive-prompts.md`
- Live help (Gemini in a voice channel): `docs/agent-guides/live-help.md`
- Thread Voice V2: `docs/agent-guides/thread-voice.md`
- Wake events (implementation): `docs/agent-guides/wake-events.md`
- The agent primer and index of all guides: `docs/agent-guides/README.md`

## Environment variables

Key variables are defined and validated in `src/config.ts`. Notable ones:

- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to use the bot
- `DISCORD_ALLOWED_CHANNEL_IDS` — optional; restrict the bot to threads in specific parent channels
- `REPOS_ROOT` — root directory the agent can access
- `DEFAULT_AGENT` — which agent profile to use by default (`copilot`, `gemini`, `claude`)

After changing `.env`, run `npm run redeploy` to rebuild and restart.

## ⚠️ CRITICAL: Claude model & effort selection requires verification

Older `claude-agent-acp` releases resolved some aliases and full IDs
inconsistently, and months of work once ran on the wrong model. The current
picker avoids those historical variants, but **do not trust model aliases,
labels, or a model's self-report.** Before changing anything about Claude models
or effort:

**READ `docs/model-management-runbook.md` first.** It is the authoritative,
empirical process. Key non-negotiables from it:

- **Verify against JSONL ground truth** (`entry.message.model`), never by asking
  the model what it is — self-reports are unreliable.
- **No local patch on claude-agent-acp 0.73.0** (ACP SDK 1.4.0): model
  selection moved to `setSessionConfigOption`, which exact-matches full canonical
  `claude-*` IDs against the agent's advertised list *before* the fuzzy resolver,
  so full IDs resolve to themselves. `scripts/patch-claude-agent-acp.mjs` is
  retired (its anchor `unstable_setSessionModel` no longer exists). **Caveat on
  this account**: a raw wrapper session can reject an un-advertised full ID, so
  the Seam Claude profile forwards canonical IDs through `ANTHROPIC_MODEL`.
  Every picker entry was JSONL-verified on 2026-09-02; `default` resolves to
  Claude Opus 5 with a 1M window.
- **The `CLAUDE_MODELS` picker in `.env`** contains only JSONL-verified,
  native-1M entries. Don't add a model without running the §4 probe in the
  runbook.
- **No `[1m]` suffix** — each model's native context window is declared in the
  `CLAUDE_CONTEXT_WINDOWS` table (`packages/adapters/src/profiles/claude.ts`), which drives
  the compaction threshold; the agent also reports the true window at runtime via
  ACP `UsageUpdate.size`. (Getting the window wrong makes a 1M model compact at 200K.)
- **Effort** is injected via `_meta.claudeCode.options.effort` (runbook §11).
  Verify the applied value in the assistant JSONL entry's top-level `effort`
  field. Valid levels are bounded by the bundled SDK's `EffortLevel` type
  (`ultra` is not available).
- The status card shows the **resolved** model + effort every turn — that is the
  standing regression alarm. If it ever shows the wrong model, stop and consult
  the runbook.

When updating `claude-agent-acp` or `@anthropic-ai/claude-code`, follow the
runbook end to end (§1 pull → §2 changelogs → §3 update → §3a patch → §4 verify).

## Troubleshooting: 500 / server errors from the Claude API

When a Claude Code session returns persistent `500 Internal server error`
responses (visible in `journalctl -u seam-acp` as `"turn failed"` with
`"errorKind":"server_error"`), **check upstream status first** before
investigating code-level causes.

Fastest path: MCP `service_status({ sourceIds: ["anthropic"] })` — cached and
instant. If `observation.health` is not `ok`, Seam has not been able to reach
the status page either, so run `service_status_refresh` before concluding
anything. Otherwise https://status.claude.com is the same data by hand; the
error message itself directs you there.

Signs it's an upstream outage rather than a bot bug:
- Multiple threads/sessions fail around the same time.
- Other threads on the same model work fine (outages can be partial / per-model).
- The status page shows an active incident (look for `status-major` or
  `status-critical` on the page body, or unresolved incidents tagged
  `impact-critical`).
- Retries keep failing with the same 500, not a different error.

**Do not** waste time debugging seam-acp code or session state when the root
cause is an Anthropic-side outage. Wait for the incident to resolve, then retry.
