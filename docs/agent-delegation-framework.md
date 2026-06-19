# Agent delegation framework — cross-thread handoffs via directives

**Status:** vision / framework (not greenlit) · **Created:** 2026-06-17 · **Owner:** jbulpitt

> **WIP implementation** lives on branch **`feat/delegation-presets`** (commit
> `3f23ae8`), committed off `main` so `main` keeps building. It does **not build
> yet** — three handlers are still unimplemented: `cmdAlias` (`/seam alias`),
> `cmdPeek` (`/seam peek`), and `emitDelegateFence` (the `seam-delegate:<alias>`
> fence). Implement those to compile. Files touched: `agent-conventions.ts`,
> `session-store.ts`, `types.ts`, `commands.ts`, `orchestrator.ts`.

Seam-acp already has two primitives that, taken together, are most of a multi-agent
orchestration harness:

1. **Per-turn preamble directives** (`agent-conventions.ts`) — the `<seam-harness>` block
   teaches every agent, on every turn, how to emit structured directives that seam-acp
   intercepts and executes as side effects. Proven with `seam-attach` (file uploads).
2. **Scheduled prompts** (`scheduled-prompts-plan.md`) — cron-style autonomous jobs that
   fire into a thread, including cross-thread `targetChannel` posting.

This document proposes extending the directive model with a **`seam-delegate`** convention
that lets an agent hand work off to a different thread's agent — turning seam-acp into a
harness for fully automated, cross-agent, cross-model workflows.

---

## 1. Why this matters

**Cost and model routing.** Each Discord thread can run a different agent profile (Claude
Opus, Sonnet, a local model via LM Studio, Gemini, Copilot). Delegation lets you route
cheap work (triage, formatting, boilerplate) to cheap models and expensive work (complex
reasoning, large refactors) to capable ones — automatically, within a single workflow.

**Perpetual agentic workflows.** Combined with scheduled prompts, delegation enables
pipelines that run indefinitely:

- A cron fires a "planning" prompt in Thread A (cheap model).
- Thread A's agent selects a story from a backlog, generates an autonomous build prompt.
- Thread A delegates the prompt to Thread B (capable model).
- Thread B implements the story, then delegates a summary back to Thread A.
- Thread A posts the summary, maybe delegates a review to Thread C (QA model).
- Next cron tick: repeat.

No human in the loop unless something breaks. The user has full visibility by reading any
thread.

**Agent-native orchestration.** The agent decides *when* and *what* to delegate based on
its own judgment — it's not following a rigid DAG. This makes the system adaptive: an agent
can delegate, retry, ask for clarification, or skip delegation entirely based on context.

---

## 2. The directive pattern — `seam-delegate`

### 2.1 Wire format

Same shape as `seam-attach`: a fenced code block with a reserved lang tag. The alias is
part of the tag (no structured body to get wrong):

    ```seam-delegate:worker3
    Implement story #42 from the backlog. The acceptance criteria are: ...

    When you are finished, delegate your summary to the qa2 thread.
    ```

- **`seam-delegate:<alias>`** — the lang tag. `<alias>` is a user-defined thread alias
  (see §3). Keeping it in the tag avoids YAML/JSON formatting errors in the body.
- **Body** — the raw prompt text to inject into the target thread. Plain text, no
  structure required. The agent writes it naturally.

### 2.2 What seam-acp does on interception

When `emitClosedFence` sees `fence.lang` starting with `seam-delegate:`:

1. **Resolve the alias** → look up the target thread ID from the alias registry (§3).
2. **Post the prompt** into the target thread as a message that triggers the target
   agent's session (same path as a user mention or scheduled-prompt fire).
3. **Post a confirmation card** in the source thread:
   *"✅ Delegated to **worker3** — prompt delivered (1,240 chars)."*
4. **Consume the fence** — it never renders as a raw code block. Failures degrade
   gracefully with an inline notice (same pattern as `seam-attach`):
   *"⚠️ Delegation failed: alias `worker3` not found."*

### 2.3 The return path

The delegated prompt can include natural-language instructions to report back:

> *"When you are finished, delegate your summary to the qa2 thread."*

This works because the **recipient agent also receives the preamble** on every turn — it
already knows the `seam-delegate` convention and the available aliases. The originating
agent doesn't need to teach the convention; it just says *what* to do and *where* to
report. The knowledge is ambient.

For even higher reliability, seam-acp could **auto-append callback instructions** when a
delegation includes a `callback` qualifier (see §5, V2).

### 2.4 Why agents will use it reliably

Evidence from `seam-attach`: agents follow the preamble convention reliably when:

- The convention is taught on **every turn** (the preamble does this).
- The format is **simple** (a lang tag + body, no nested structure).
- The user's intent **maps obviously** to the convention ("hand it off" → `seam-delegate`).

The chained case (A delegates to B, B reports back to A) is surprisingly tractable because
every agent in every thread already knows the convention from its own preamble. The
originating agent never has to embed meta-instructions about *how* to delegate — just
*what* to do and *where* to report.

The main reliability risk is not format fidelity — it's that an agent finishes work and
posts the result in its own thread without remembering to delegate. Mitigations:

- **Auto-appended reminder** (see §5 V2): seam-acp appends a hard instruction at the end
  of every delegated prompt.
- **Watchdog** (see §4): an external process that detects when a delegation target goes
  quiet without reporting back.

---

## 3. Thread aliases — the registry

Thread aliases are a **power-user feature**. Users define them via a slash command with an
interactive input card:

```
/seam alias set worker3 1234567890123456789
/seam alias set qa2      9876543210987654321
/seam alias list
/seam alias remove worker3
```

**Storage:** a new `thread_aliases` table in `seam.db`:

- `alias` (TEXT PRIMARY KEY) — the short name, e.g. `worker3`
- `channel_ref` (TEXT NOT NULL) — the Discord thread/channel ID
- `description` (TEXT) — optional, shown in help and the preamble
- `created_at` (TEXT NOT NULL)

**Preamble integration:** `harnessPreamble()` queries the alias registry and appends the
available aliases to the delegation convention bullet:

```
• To delegate work to another thread, output a fenced code block whose
  info tag is `seam-delegate:<alias>`. The body is the prompt to send.
  Available threads: worker3 (build agent), qa2 (QA reviewer), planner (triage).
```

If no aliases are registered, the delegation bullet is omitted entirely — zero noise for
users who haven't opted in.

---

## 4. Watchdog — anomaly detection over chain detection

Rather than building brittle, in-band chain-depth counters or per-delegation approval
gates, safety is handled by an **external watchdog process** — an orthogonal monitoring
layer that keeps the delegation system itself simple.

### 4.1 What the watchdog monitors

- **Delegation frequency:** how many delegations per thread per time window. A thread
  that delegates 50 times in 10 minutes is anomalous.
- **Loops:** A→B→A→B delegation cycles. Detected by tracking the delegation graph
  (source → target edges) and looking for strongly connected components.
- **Quiet targets:** a delegation was sent but the target thread produced no output and
  no callback within a configurable timeout. The originating thread may be waiting
  forever.
- **Total token/cost spend per workflow:** if delegations form a tree, the watchdog can
  sum estimated cost across the tree and alert when a single workflow exceeds a budget.

### 4.2 What the watchdog does

- **Alert:** post a notice card in the originating thread and/or a monitoring channel:
  *"⚠️ Delegation loop detected: worker3 → qa2 → worker3 (3 cycles). Pausing."*
- **Pause:** stop delivering delegated prompts to the target thread until a human reviews.
  The delegation is "parked" (queued in the DB, not lost).
- **Configurable thresholds:** per-alias or global limits, set via slash command or
  `.env`. Defaults are generous (a legitimate workflow might chain 5–10 hops).

### 4.3 Why this is better than in-band chain detection

- **Catches emergent problems** the designer didn't anticipate (cost spikes, unexpected
  delegation patterns, agents delegating to themselves).
- **Doesn't complicate the delegation codepath** — the `emitClosedFence` handler stays
  simple (resolve alias, post message, confirm). Safety is layered on top.
- **Runs independently** — can be a cron script (like `bump-threads.mjs` and
  `prune-dead-sessions.mjs`), or an in-process periodic check.

### 4.4 Delegation ledger

Every delegation is logged to a `delegation_log` table:

- `id` (TEXT PRIMARY KEY)
- `source_channel` (TEXT NOT NULL) — originating thread
- `target_alias` (TEXT NOT NULL)
- `target_channel` (TEXT NOT NULL) — resolved thread ID
- `prompt_preview` (TEXT) — first ~200 chars, for debugging
- `callback_alias` (TEXT) — if a callback was specified
- `status` (TEXT) — `delivered`, `callback_received`, `timed_out`, `paused`
- `created_at` (TEXT NOT NULL)
- `resolved_at` (TEXT) — when a callback arrived or timeout fired

The watchdog queries this table. It also serves as an audit trail — the user can see the
full delegation history for any workflow.

---

## 5. Incremental build path

### V0 — Prove agent compliance (no infrastructure)

Add a hypothetical `seam-delegate` bullet to the preamble in a test thread. Ask the agent
to compose a delegation. Verify the output is well-formed. This validates the agent-side
reliability with **zero code changes**.

### V1 — MVP: single-hop delegation

- **Alias registry** — `thread_aliases` table + `/seam alias` slash command.
- **Preamble extension** — add the delegation bullet to `harnessPreamble()`, populated
  from the alias registry.
- **Fence interception** — new branch in `emitClosedFence` for `seam-delegate:*`.
  Resolves alias, posts prompt to target thread, posts confirmation in source thread.
- **Delegation ledger** — `delegation_log` table, written on every delegation.
- **No callback automation, no watchdog.** The user checks the target thread manually.
  The agent can include natural-language callback instructions, and the recipient will
  follow them (it knows the convention from its own preamble), but there's no enforcement.

Estimated effort: **1–2 days.** The `emitClosedFence` dispatch, alias lookup, and message
posting are all short additions to existing code.

### V2 — Callbacks and auto-reminders

- **`callback` qualifier** in the lang tag: `seam-delegate:worker3:callback=qa2`. Seam
  auto-appends callback instructions to the delegated prompt:
  *"When you are done, use `seam-delegate:qa2` to report your results."*
- **Delegation status tracking** — update ledger rows when callbacks arrive. Post a
  "✅ Callback received from worker3" notice in the originating thread.
- **Timeout watchdog** — a periodic check (cron or in-process) that flags stale
  delegations (delivered but no callback within N minutes). Posts a notice:
  *"⏳ worker3 hasn't reported back after 30 min."*

### V3 — Watchdog and workflow awareness

- **Full watchdog** — loop detection, frequency limits, cost estimation.
- **Workflow tree view** — a `/seam workflows` command that shows the delegation graph
  for active workflows (which threads are waiting on which).
- **Pause/resume** — watchdog can park delegations; user can `/seam delegation resume`.

### V4 — Scheduled prompt integration

- **Scheduled prompts as workflow triggers.** A cron fires a planning prompt; the
  planning agent delegates build tasks; build agents report back; the planning agent
  summarizes. The cron → delegate → callback → delegate loop runs perpetually.
- **Workflow templates** — predefined delegation patterns (e.g. "plan → build → QA →
  report") configurable via slash command, so the user doesn't have to embed the full
  chain instructions in every scheduled prompt.

---

## 6. Existing infrastructure this builds on

- **`seam-attach`** (`agent-conventions.ts`, `orchestrator.ts:5209–5298`) — proves the
  directive pattern end-to-end: preamble teaches → agent emits → `emitClosedFence`
  intercepts → side effect executes → fence consumed.

- **Scheduled prompts** (`core/scheduled-prompts/`) — already have `targetChannel`
  (post output to a different thread), `model` override per schedule, isolated execution,
  catch-up semantics. Delegation is the agent-initiated version of what scheduled prompts
  do on a timer.

- **Session store** (`core/session-store.ts`) — `sessions` table already maps threads to
  agents, repos, and profiles. The alias registry is a thin addition.

- **`emitClosedFence`** (`orchestrator.ts:5209`) — the dispatch point. Adding a new
  `seam-delegate` branch is the same pattern as `seam-attach`.

- **`harnessPreamble()`** (`agent-conventions.ts:26`) — the injection point. Adding a
  delegation bullet with available aliases is one more array entry.

---

## 7. Design principles

1. **Agents decide, seam executes.** The agent chooses when and what to delegate based
   on context. Seam-acp is the message bus, not the orchestrator. This keeps the
   delegation system simple and the intelligence in the agents.

2. **Convention over configuration.** The directive format is a simple fenced code block
   — the same pattern every agent already knows. No new APIs, no structured protocols,
   no agent-side SDKs.

3. **Ambient knowledge via preamble.** Every agent in every thread knows the delegation
   convention and the available aliases because the preamble teaches it on every turn.
   No meta-prompting required for chained workflows.

4. **Safety is orthogonal.** The watchdog monitors and intervenes from outside the
   delegation codepath. The delegation handler itself stays simple: resolve, post,
   confirm. No inline safety checks to complicate the hot path.

5. **Full user visibility.** Every delegation posts a confirmation card. Every thread
   is readable. The user can intervene at any point by posting in any thread. Discord
   is the UI — no separate dashboard needed.

6. **Graceful degradation.** Unknown alias → inline error notice. Target thread deleted →
   notice. Platform can't send messages → notice. Same pattern as `seam-attach` failures.
   Never silent, never crashes.
