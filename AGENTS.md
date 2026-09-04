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
  `configure_thread(thread, { agent?, model?, effort?, role?, disableThreadPrefix? })`
  changes its agent / model / effort / naming role and reports what actually
  reset (agent switch always resets; model switch resets on codex/ollama, not
  claude; effort never does); `reset_thread_session(thread)` clears its context
  but keeps the model. Same in-channel scope as `handoff`.
- **`role` is what a thread is for, not how it runs:** a free-form label
  (`worker`, `qa`, `orchestrator`, …) that is a first-class config dimension
  beside agent/model/effort. It drives the role symbol in the thread name and
  groups threads for enumeration. Thread names are maintained by Seam from
  agent + model + role + ordinal — **do not hand-rename a thread to fix its
  prefix**; set the identity and the name follows.
- **Migrate your own thread to a new brain and keep working:**
  `migrate_self({ agent?, model?, effort?, manifest })` stages an agent/model
  switch until your current turn ends, then seeds the fresh session with your
  free-form continuation manifest as its first prompt. It is self-only and
  purpose-agnostic; use it for capability, cost, availability, quota, or any
  other reason you decide. At least one of agent/model must actually change.
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

## Slash command tree (`/seam` + `/seamadmin`)

Discord caps a **single** application command at 8,000 characters — the sum of
every name, description and choice value in the tree — and at 25 top-level
options. Blowing either makes Discord reject registration of the **entire
command at boot**, not just the new option. `/seam` reached 7,885/8,000, which
is why #150 could only add `role-name` by deleting help text.

The budget is **per command**, so #151 split the tree in two. Hard cutover —
Discord has no aliases; old invocations simply disappear.

### `/seam` — everyday user + agent surface (8 slots)

**Top-level (5):** `cancel`, `steer`, `new`, `workflows`, `queue`

**Groups (3):**
- `config` (18): `model` `effort` `agent` `role` `mode` `repo` `tools` `card`
  `gif` `approve` `reset` `init` `detach` `tts` `show` `edit` `set` `audit`
  - `role` sets a thread's naming role. `rename` / `namer` are **no longer
    here** — they live under `/seamadmin naming`.
  - `edit` is the **one** configuration surface (#157): `/seam new` and
    `/seam config init` both post this card instead of running a setup wizard.
    There is no host selector on it — an agent id is `agentId@location`, so
    the **Agent** picker binds the host too and Host is shown read-only (#156).
    To pre-bind a host that is currently offline (it lists no agents), use
    `/seam config agent id:<agentId>@<host>`.
- `info` (6): `whoami` `usage` `avatar` `help` `sessions` `repos`
- `preset` (7): `list` `create` `apply` `delete` `show` `edit` `thread`

### `/seamadmin` — operator surface (8 slots)

Registered with `default_member_permissions = ManageGuild` and
`contexts = [Guild]` (via `setContexts`, not the deprecated `setDMPermission`),
so it does not appear in the command picker for non-admins and is unavailable
in DMs.

That permission is **visibility, not authorization** — a guild admin can grant
the command to anyone, so every runtime refusal stays exactly where it was:
`SEAM_CONFIG_ADMIN_USER_IDS` for `upload` / `rebuild` / `naming`, plus
`BRIDGE_ADMIN_REFUSAL` and `THREAD_VOICE_ADMIN_REFUSAL`.

**Top-level (1):** `rebuild`

**Groups (7):**
- `schedule` (5): `add` `list` `remove` `toggle` `edit` — **no attachments**
  (#158). A scheduled prompt carries no files on any surface; when a job needs
  substantial instructions, commit a runbook and make the prompt a short request
  to follow it. A pre-#158 row that still records files is **quarantined** (never
  armed, never fired); editing the schedule clears that record and re-arms it.
  Stored bytes under `data/scheduled-attachments/` are never deleted by Seam.
- `project` (3): `new` `list` `remove`
- `upload` (3): `pull` `push` `secret`
- `bridge` (4), `debug` (6) — pairing / host debug (`voice-ping` /
  `voice-capture` / `voice-live` are the live-help spike)
- `voice` (7): `start` `add` `remove` `configure` `console` `status` `stop` —
  Shared Voice Console V2
- `naming` (2): `rename` `namer` — lifted out of `config` by #151. `rename`
  refreshes/migrates thread names (`migrate-legacy:true` for old hand-typed
  prefixes, `role-name:true` to rebuild from the role); `namer` edits the
  agent/model/role symbol tables. **Do not hand-rename a thread to fix its
  prefix** — set the identity and the name follows.

**Moved by #151:** `/seam rebuild|schedule|project|upload|bridge|debug|voice`
→ `/seamadmin …`, and `/seam config rename|namer` → `/seamadmin naming …`.

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

## Live help (#98)

Gemini joins a Discord **voice channel** (not TTS, not STT). Coaching agents
mint with MCP `create_live_help` (no fence); `cancel_live_help` hangs up.
`voiceChannelId` comes from **this thread’s rider** if it names a VC, else
family-guild General. Students may request, start, and stop their own session
through the course agent; do not ask a parent/admin for approval.
Canonical: `docs/agent-guides/live-help.md`. School overlay paste:
`docs/agent-guides/live-help-onboarding.md`. Do not use `/seamadmin debug voice-*`
from a course thread.

## Thread Voice V2

One admin owns one guild-scoped Shared Voice Console in their current self-muted
voice channel. `/seamadmin voice start` creates its first thread binding; `add`,
`remove`, and `configure` manage up to ten aliased bindings. The canonical
five-row card exists only in the voice channel's built-in chat. The owner/admin
selects one input binding or explicitly arms fan-out; allowlisted speakers are
captured automatically while present, and final
transcripts retain the actual speaker identity and enter each thread's normal
turn queue. Every visible bound-thread response shares one fair VC speech
scheduler, while per-binding output may be disabled. `stop` preserves finalized
text by default. Canonical operator notes: `docs/agent-guides/thread-voice.md`.

Thread Voice and Live Help share one guild voice lease. A conflict should name
the active product/session; it is never an authorization or parent-approval
failure. Live Help remains student self-service through course agents.

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
responses (visible in `pm2 logs` as `"turn failed"` with
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
