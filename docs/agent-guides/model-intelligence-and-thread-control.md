# Models & cross-thread session control

Canonical guide for agents choosing models or reconfiguring another Seam thread.
These seam-MCP tools are available in every channel with no per-project setup.
The metadata and thread controls are provider-agnostic; the clearly marked
`model_value_rankings` tool is Copilot-specific.

Consuming projects pin this raw URL:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/model-intelligence-and-thread-control.md`

There are three capability families:

1. **Model intelligence data** — cached, fast, read-only lookups of model
   benchmarks, pricing, and cost-efficiency ("value") rankings.
2. **Conversation lookup** — live text search and ordered context windows over
   your thread and sibling threads in the same channel.
3. **Session control and identity** — reconfigure/reset another thread (agent,
   model, effort, role), or migrate your own thread to a fresh agent/model with
   an explicit continuation manifest.

---

## 1. Model intelligence data (read-only, cache-backed)

All three tools read a cache that a background job refreshes ~every 12h (and on
boot). They **never** make a live API call or spawn a CLI, so they return in
milliseconds and are safe to call as often as you like. Source: Artificial
Analysis (benchmarks) + GitHub Copilot pricing + the Copilot CLI (valid effort
tiers). Not every model is benchmarked — open-weight / proprietary ones (e.g.
MAI-Code, some Ollama models) appear with `null` benchmark/value; handle nulls.

### `model_value_rankings({ tier?, benchmark? })`
Best **cost-efficiency** ranking of the Copilot model catalog: an Artificial
Analysis benchmark divided by that model's Copilot per-token cost for a fixed
standard task (8k input / 2k output tokens). Ranked **by value within capability
tiers** so you compare like with like.
- `tier` (optional): `flagship` | `balanced` | `flash` — filter to one tier.
- `benchmark` (optional): an AA evaluation key (e.g. `artificial_analysis_coding_index`).
  Defaults to the Intelligence Index rollup.
- Each row: `model`, `tier`, `value_score` (higher = better value), `benchmark {name,value}`,
  `pricing { input_per_million, output_per_million, …, credits_per_standard_task }`,
  `valid_effort_tiers` (per-model, e.g. `["low","medium","high","xhigh"]`),
  `price_category`.

Use it to answer "what's the best-value model in class X" or to steer a worker
onto a cheaper model that still clears a quality bar.

### `model_metadata_query({ filters?, sort?, limit? })`
Query cached metadata for models across **all** configured agents (claude, codex,
grok, agy, copilot, ollama-cloud, opencode…).
- `filters`: `provider`, `creator`, `agent` (which agent can run it),
  `minContextWindow`, `benchmark {name?, min}`,
  `maxPrice {input?, output?}` ($/Mtok), `releasedAfter` (YYYY-MM-DD),
  `nameContains`, `hasBenchmark`.
- `sort`: `{ field: benchmark|price|inputPrice|outputPrice|contextWindow|releaseDate|name, direction, benchmark? }`.
- `limit`: 1–100.
- Each model: `id`, `name`, `aliases`, `provider`, `creator`, `agents` +
  `agent_models` (the id each agent uses), `context_window`,
  `intelligence_index`, full `benchmarks` map (coding index, GPQA, HLE, SciCode,
  terminalbench, τ-bench, …), `pricing`, `released_at`.

Use it for "which models score ≥ 75 on coding under $10/Mtok output", "what can
`agent=grok` run", "newest 1M-context models", etc. Usable input modality is
host-scoped; consult the selected agent's catalog/runtime `visionMode` instead.

### `model_metadata_get(idOrSlug)`
Same rich record as above, for a single model by id or slug. Use when you already
know the model and just want its numbers.

---

## 2. Conversation lookup (read-only, live Discord fetch)

These tools read Discord on demand; they do not use a persisted message index.
`search_messages` and `read_messages` are scoped to the calling thread's
channel, matching `threads()` and the cross-thread control boundary. A named
thread outside that channel is refused. `peek` deliberately retains its older,
broader cross-channel recent-N reach.

### `search_messages(query, { threads?, author?, since?, limit? })`
Search human and bot conversation text and return stable `messageId` anchors.

- Omit `threads` to search your own thread, pass an array of sibling thread ids,
  or pass `"channel"` to search every bound thread in the channel.
- `author` accepts `human`, `bot`, or an exact Discord author id. `since`
  accepts an ISO timestamp or a relative window such as `30m`, `2h`, or `7d`.
- Status/choice/UI cards and pure status lines are excluded from search.
  Consecutive streamed bot fragments collapse into one logical hit.
- `truncated: true` means the requested hit limit or bounded live-fetch page
  budget was reached; narrow the threads, `since`, or query before assuming the
  result is exhaustive.

### `read_messages(thread, { around?, before?, after?, limit? })`
Read one chronological message window (up to 100 rows). Omit anchors for the
latest messages, or use exactly one message-id anchor. `around` is the normal
follow-up to a `search_messages` hit. This context path is intentionally
unfiltered: human messages, bot messages, attachments, and cards are included;
`isCard` marks UI/status rows.

### `peek(thread, count?)`
The compact latest-N presentation remains public for quick catch-up. It shares
the live fetch, ordering, and rate-limit reader with `read_messages`, but accepts
any raw Discord thread id—including an outside-channel thread with no Seam
session. It is not subject to the same-channel scope of the cursor-addressed
`read_messages` and `search_messages` tools.

---

## 3. Session control

There are two scopes. `configure_thread` and `reset_thread_session` target
**another thread** in your channel, using the same trust boundary as `steer` and
`handoff`. `migrate_self` targets only the calling thread. They compose with the
data tools: inspect the candidates first, then apply the selected runtime.

### `configure_thread(thread, { agent?, model?, effort?, role?, disableThreadPrefix? })`
Change a target thread's agent, model, reasoning effort, naming role, and/or
naming opt-out (at least one field required).
- **The result is exact, including no-ops.** Agent, model, and effort are always
  returned as the effective post-set identity; each field says whether it
  changed and names its previous value when it did. The target thread receives
  the same information in a visual confirmation card.
- **The thread identity follows the setting.** A managed thread's name carries a
  short symbol prefix derived from its identity, so changing agent, model, or
  role updates that prefix automatically — you never rename a thread by hand to
  keep it accurate. `threads()` also stamps every entry with effective
  agent/model/effort, so a coordinator can verify the target without waking it.
  See "Reading a thread name" below.
- **Reset is reported, not assumed.** Switching **agent** always starts a fresh
  session (context lost). Switching **model** resets on backends that pin the
  model at session start (codex, ollama-cloud) but not on those that switch live
  (claude). Switching **effort** never resets the ACP session. Config-option
  agents update live; metadata/spawn-argument agents such as Claude reload the
  runtime process with their ACP session and conversation context preserved.
  The result distinguishes `sessionReset` from `runtimeReloaded`.
- **Effort is validated per model.** Valid tiers differ by model
  (`minimal < low < medium < high < xhigh < max`); pass `auto` to let the backend
  pick its default. An unsupported value is refused or coerced to `auto`, never
  silently sent. (Get a model's valid tiers from `valid_effort_tiers` in
  `model_value_rankings`, or the metadata tools.)
- **Preset shadowing is prevented.** The set is persisted as a per-thread
  overlay, so a channel preset cannot leave the runtime or `threads()` display
  on the old agent/model/effort. A compact authoritative identity stamp is also
  injected into the target's subsequent turns.
- **`role` is a free-form label, not an enum.** It says what a thread is *for*
  (`worker`, `qa`, `orchestrator`, `analyst`, `planner`, …) and is a first-class
  configuration dimension alongside agent/model/effort. It never changes the
  runtime: it identifies the thread, drives the role symbol in its name, and
  groups the thread for enumeration. Pass an empty string or `auto` to clear it.
  Set it when you create or repurpose a teammate so coordinators can tell your
  workers, reviewers, and planners apart without opening them.
- **`disableThreadPrefix` opts a thread out of managed naming.** When true, Seam
  stops maintaining that thread's name prefix and leaves its title alone.
  Uncommon — use it only for a thread whose title a human curates deliberately.

### Reading a thread name

Thread names are meaningful, not decorative. A managed thread's title is a
compact symbol prefix followed by its base name:

`[agent][model][role][n] base name`

- **agent** — which backend runs it (👾 Claude, 🧬 Codex, 🌌 Agy, 🤖 Copilot, …).
- **model** — the model family or variant currently selected.
- **role** — what the thread is for, from its `role` setting (🛠️ worker,
  🧪 qa, 🪄 orchestrator, 🔬 analyst, …).
- **n** — an enumeration keycap separating threads that share a role in the same
  channel (1️⃣, 2️⃣, … 🔟 and beyond).

Any slot may be absent; a thread with no role has no role symbol and no number.
Seam maintains the prefix itself whenever a thread's identity changes, so you
can read a `threads()` listing and know each teammate's backend and purpose at a
glance. Treat the *grammar* as stable and the specific glyphs as host
configuration that can change. `threads()` remains the authoritative source for
effective agent/model/effort, and a thread's `id` is the only thing you should
ever address — never parse or match on its name.

### `reset_thread_session(thread)`
Start a fresh session on a thread, keeping its current agent + model. Clears
conversation context. Use to recover a wedged/confused thread without changing
its model.

### `migrate_self({ agent?, model?, effort?, manifest })`
Migrate **your calling thread itself** to a different agent and/or model. It
takes no thread id: the seam session token is the sole target authority.
- At least one of `agent` or `model` must actually change. `effort` may accompany
  the migration but cannot be the only change.
- Supply a required free-form `manifest` containing current state, decisions,
  references, and next work. It is delivered as the **first prompt on the new
  session**, preserving intentional continuity without copying old context.
- The tool stages while your current turn is active. The invoking turn ends
  normally; the channel FIFO then performs the reset, posts a neutral switch
  notice, and starts the manifest on the replacement runtime.
- The mechanism is purpose-agnostic. It does not consult quota, rankings,
  pricing, governance, or admin policy; use the intelligence tools yourself if
  those facts matter to your decision.
- Target validation happens before staging. Replacement startup failure rolls
  durable state back to the prior agent/model/ACP session.

---

## Related, FYI

- The Artificial Analysis benchmark data is also exposed as its own MCP server
  (`artificial-analysis`) for direct model lookups, but for cost-aware decisions
  prefer `model_value_rankings` (it joins in Copilot pricing).

## Gotchas
- **Value ranking is Copilot-cost-specific** (GitHub per-token pricing). The raw
  `model_metadata_*` benchmarks are provider-agnostic.
- **Coverage is partial** — always tolerate `null` benchmark/value/pricing on
  models AA doesn't track.
- **Freshness** — data is a cache snapshot (≤12h old); `fetched_at` is on every
  response if you need to reason about staleness.

_Provenance: seam-acp issues #130 (value ranking), #132 (cross-thread control),
#134 (metadata cache), #141 (self migration), #143 (message search/read),
#145 (thread role + identity naming); drain-safety fix #137._
