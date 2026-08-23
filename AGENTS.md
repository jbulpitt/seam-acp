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
- **A file he should open:** `seam-attach` fence (path only), not a path in prose.
- **Another thread in this channel:** `threads()` first. Idle → `handoff` /
  `forward`. Busy → `send` (inbox; they `poll_inbox`). Set `returnTo` to that
  thread when he does not want a report-back here. Never hand off to `isSelf`.
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
- **Git worktrees:** `wt` only — see Git worktrees below.

`poll_inbox` at the start of a turn (and at checkpoints). Empty is normal.

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

## Git worktrees

Use this host's `wt` CLI only (`~/.local/bin/wt`). Do **not** call `git worktree add` / `git worktree remove --force`, symlink `node_modules`, `npm install` a second copy to satisfy a bundler, park trees under `/tmp` or as visible `~/Projects/<name>` siblings, or invent a project-local worktree helper. This repo has no provisioner — call `wt` directly.

Layout: `~/Projects/.worktrees/seam-acp/<name>/`. Bind-mount `node_modules` from the main checkout (never symlink). Teardown unmounts first — a force-remove of a still-mounted `node_modules` deletes the main install. After reboot: `wt bind-all --repo /home/ubuntu/Projects/seam-acp`.

Load `~/.local/share/wt-helpers/AGENTS.md` before creating or tearing down a tree. If `wt` is missing, run `~/.local/share/wt-helpers/install.sh` then `wt doctor`.

## Slash command tree (`/seam`)

Discord caps each command at 25 top-level options. `/seam` is 13/25: 5
top-level subcommands + 8 groups. Future surfaces default to living
**inside a group** (each group has its own 25 budget). Hard cutover —
Discord has no aliases; old invocations disappear.

**Top-level (5):** `cancel`, `steer`, `new`, `workflows`, `queue`

**Groups (8):**
- `config` (16): `model` `effort` `agent` `mode` `repo` `tools` `approve` `card` `reset` `init` `detach` `tts` `show` `edit` `set` `audit`
- `info` (6): `whoami` `usage` `avatar` `help` `sessions` `repos`
- `schedule` (7), `preset` (6), `project` (3) — unchanged
- `upload` (3): `pull` `push` `secret` — **admin-only**. Hard cutover of `/seam attach`.
- `bridge` (4), `debug` (3) — admin-only pairing / host debug

**Queue:** `/seam queue prompt:…` parks the next live turn (does not abort).
Idle + host ready runs now. A later bare message still interrupts and
cancels the queued prompt. Shares the `#88` parked row.

**Cancel options** (not new keywords):
- `/seam cancel` — this thread, graceful
- `/seam cancel force:true` — this thread, escalate (old `abort`)
- `/seam cancel scope:all` — kill every active session bot-wide (old `kill`). Privileged: **not** lock-exempt, **not** participant-allowed.

**Removed:** `/seam image`.

## Interactive prompts (#91 / #92 / #94)

Frozen Discord click-cards and HTTP ingest for microsites. **While pairing in
this repo, a card is the check-in** — see Dogfood above. Canonical how-to:
`docs/agent-guides/interactive-prompts.md`. Default is **live in this thread,
one person, one pick** — after they choose, the card shows the selection and
buttons go away. **Multi-select (#94):** set `select: { min, max }` for a
dropdown + Confirm instead of one-click buttons — the user ticks several
options and **one combined prompt** is emitted, then the card freezes showing
`Selected: A, B, C`. All options must be `kind:"prompt"`; not combinable with
`maxClicks` > 1. `maxClicks` > 1 only for multi-user. MCP `create_choice` /
`cancel_choice` / `submit_result`, or fences `seam-choice` / `seam-result`.
HTTP `POST /ingest` is a custom-option submit; the site gets **declared JSON**
from `submit_result`. Microsites that need **no Discord card** use MCP
`create_ingest` (isolated silent, retries unlimited; `preset` resolved at
fire). Participants click; they do not author.

## Agent-scheduled wake events (#59)

An agent can schedule its **own** one-shot future re-entry into its thread —
"wake me in N minutes and replay this prompt." This is the working substrate for
deferred self-follow-up; the **native `ScheduleWakeup` / `Monitor` tools do NOT
function over ACP** (nothing is emitted post-`end_turn`), so agents must use this
mechanism instead:

- **With seam-MCP:** `schedule_wake({ delaySeconds, reason, prompt })` →
  `{ wakeId }`, and `cancel_wake(wakeId)`.
- **Without MCP (e.g. agy):** emit a fenced block tagged `seam-wake` whose body
  is JSON `{ delaySeconds, reason, prompt }`. The bridge arms the wake and
  removes the block (same path the MCP tool wraps).

Semantics mirror upstream `ScheduleWakeup`: **one-shot** (fires once, then the
row is deleted), **durable** (survives `npm run redeploy`), delivered as a
**live** turn with the thread's context intact, and **self-renewing only if you
re-arm during the woken turn** — nothing repeats automatically. Delay floor 60s,
ceiling 7 days. Loop-safety backstops (min-delay, chain-depth cap, per-thread
cap) live in `src/core/wake/types.ts`.

Implementation: `wake_events` table (`session-store.ts`), the DB sweeper
`src/core/wake/manager.ts` (D11 — poll, don't arm timers), and delivery through
the shipped dispatch queue (`fireWake` → `enqueueDispatchSpec` → `DispatchWatcher`
→ `dispatchInjectTurn`, ledgered as `kind: "wake"`). Pending wakes are visible
and cancellable via `/seam workflows` (and `/seam workflows cancel-wake:<id>`).

## Environment variables

Key variables are defined and validated in `src/config.ts`. Notable ones:

- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to use the bot
- `DISCORD_ALLOWED_CHANNEL_IDS` — optional; restrict the bot to threads in specific parent channels
- `REPOS_ROOT` — root directory the agent can access
- `DEFAULT_AGENT` — which agent profile to use by default (`copilot`, `gemini`, `claude`)

After changing `.env`, run `npm run redeploy` to rebuild and restart.

## ⚠️ CRITICAL: Claude model & effort selection is a minefield

The `claude-agent-acp` wrapper resolves model strings **inconsistently and
silently wrong** (e.g. the alias `opus[1m]` resolves to *Sonnet*; the full ID
`claude-sonnet-4-6[1m]` silently gives a 200K window). Months of work once ran
on the wrong model because of this. **Do not trust model aliases, labels, or a
model's self-report.** Before changing anything about Claude models or effort:

**READ `docs/model-management-runbook.md` first.** It is the authoritative,
empirical process. Key non-negotiables from it:

- **Verify against JSONL ground truth** (`entry.message.model`), never by asking
  the model what it is — self-reports are unreliable.
- **No local patch as of claude-agent-acp 0.54.1** (ACP SDK 1.1.0): model
  selection moved to `setSessionConfigOption`, which exact-matches full canonical
  `claude-*` IDs against the agent's advertised list *before* the fuzzy resolver,
  so full IDs resolve to themselves. `scripts/patch-claude-agent-acp.mjs` is
  retired (its anchor `unstable_setSessionModel` no longer exists). **Caveat on
  this account**: the SDK advertises only `default/sonnet/haiku`, so an
  un-advertised full ID can be *rejected* (`Invalid value for config option
  model`) — `default` → latest Opus is the proven path; explicit
  Opus/Fable/Sonnet-5 entries are pending live validation.
- **The `CLAUDE_MODELS` picker in `.env`** contains only JSONL-verified entries.
  Don't add a model without running the §4 probe in the runbook.
- **No `[1m]` suffix** — each model's native context window is declared in the
  `CLAUDE_CONTEXT_WINDOWS` table (`src/agents/profiles/claude.ts`), which drives
  the compaction threshold; the agent also reports the true window at runtime via
  ACP `UsageUpdate.size`. (Getting the window wrong makes a 1M model compact at 200K.)
- **Effort** is injected via `_meta.claudeCode.options.effort` (runbook §11),
  NOT `set_config_option` (which errors). Valid levels are bounded by the
  bundled SDK's `EffortLevel` type (`ultra` is not available).
- The status card shows the **resolved** model + effort every turn — that is the
  standing regression alarm. If it ever shows the wrong model, stop and consult
  the runbook.

When updating `claude-agent-acp` or `@anthropic-ai/claude-code`, follow the
runbook end to end (§1 pull → §2 changelogs → §3 update → §3a patch → §4 verify).

## Troubleshooting: 500 / server errors from the Claude API

When a Claude Code session returns persistent `500 Internal server error`
responses (visible in `pm2 logs` as `"turn failed"` with
`"errorKind":"server_error"`), **check https://status.claude.com first** before
investigating code-level causes. The error message itself directs you there.

Signs it's an upstream outage rather than a bot bug:
- Multiple threads/sessions fail around the same time.
- Other threads on the same model work fine (outages can be partial / per-model).
- The status page shows an active incident (look for `status-major` or
  `status-critical` on the page body, or unresolved incidents tagged
  `impact-critical`).
- Retries keep failing with the same 500, not a different error.

**Do not** waste time debugging seam-acp code or session state when the root
cause is an Anthropic-side outage. Wait for the incident to resolve, then retry.
