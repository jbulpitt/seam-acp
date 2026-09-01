# Model metadata & cross-thread control — agent primer

_Shipped 2026-09-01. Audience: agents in any seam-managed project, on **any**
agent backend. These are seam-MCP tools — call them the same way you call
`handoff` / `threads` / `poll_inbox`. Available in every channel, no per-project
setup. Everything here is provider-agnostic._

> Working specifically on GitHub Copilot? There's also a Copilot-only
> cost-efficiency ranking (`model_value_rankings`) documented in
> `model-intelligence-and-thread-control.md`. It's not covered here because it
> only applies to the Copilot backend.

Two capability families:

1. **Model metadata** — cached, fast, read-only lookups of model benchmarks,
   pricing, and context across every agent.
2. **Session control** — reconfigure/reset another thread, or migrate your own
   thread to a fresh agent/model with an explicit continuation manifest.

---

## 1. Model metadata (read-only, cache-backed)

Reads a cache that a background job refreshes ~every 12h (and on boot). These
**never** make a live API call or spawn a CLI, so they return in milliseconds and
are safe to call as often as you like. Source: Artificial Analysis. Coverage is
partial — open-weight / proprietary models AA doesn't track appear with `null`
benchmark/pricing; tolerate nulls.

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
  `agent_models` (the id each agent uses for it), `context_window`,
  `intelligence_index`, full `benchmarks` map (coding index, GPQA, HLE, SciCode,
  terminalbench, τ-bench, …), `pricing`, `released_at`.

Use it for "which models score ≥ 75 on coding under $10/Mtok output", "what can
`agent=grok` run", "newest 1M-context models", etc. Usable input modality is
host-scoped; consult the selected agent's catalog/runtime `visionMode` instead.

### `model_metadata_get(idOrSlug)`
The same rich record for a single model by id or slug. Use when you already know
the model and just want its numbers.

---

## 2. Cross-thread session control

These mutate **another thread's** live session, scoped to your own channel — the
same trust boundary as `steer` / `handoff` (any agent in the channel may call
them; the target must be a thread in your channel).

### `configure_thread(thread, { agent?, model?, effort? })`
Change a target thread's agent, model, and/or reasoning effort (at least one
field required).
- **Reset is reported, not assumed.** Switching **agent** always starts a fresh
  session (context lost). Switching **model** resets on backends that pin the
  model at session start (codex, ollama-cloud) but not on those that switch live
  (claude). Switching **effort** never resets. The tool returns what actually
  happened (`sessionReset` + reason) per backend — read it.
- **Effort is validated per model.** Valid tiers differ by model
  (`minimal < low < medium < high < xhigh < max`); pass `auto` to let the backend
  pick its default. An unsupported value is refused or coerced to `auto`, never
  silently sent. (A model's valid tiers are in the `model_metadata_*` records.)

### `reset_thread_session(thread)`
Start a fresh session on a thread, keeping its current agent + model. Clears
conversation context. Use to recover a wedged/confused thread without changing
its model.

### `migrate_self({ agent?, model?, effort?, manifest })`
Migrate **your calling thread itself** to a different agent and/or model. This
is deliberately not cross-thread: it takes no thread id and resolves its target
only from your seam session token.
- `manifest` is required free-form continuation context: completed work,
  decisions, references, and the precise next action. It becomes the **first
  turn on the replacement session**.
- The operation is staged while your current turn is live. Finish that turn
  normally; only after it releases the thread does Seam reset the runtime,
  apply the target agent/model/effort, post a factual migration notice, and run
  the manifest.
- It is purpose-agnostic. Capability, cost, availability, and quota are all
  possible reasons, but the tool checks none of them and applies no governance
  policy.
- Invalid targets are refused before staging. If replacement startup fails,
  Seam restores the prior agent/model and ACP session instead of leaving an
  empty replacement behind.

---

## Gotchas
- **Coverage is partial** — always tolerate `null` benchmark/pricing on models AA
  doesn't track.
- **Freshness** — data is a cache snapshot (≤12h old); `fetched_at` is on every
  response if you need to reason about staleness.
- **Pricing** here is the model's list/API pricing as reported by Artificial
  Analysis (provider-agnostic), not any single provider's billing.

_Provenance: seam-acp issues #132 (cross-thread control), #134 (metadata cache),
#141 (self migration); drain-safety fix #137._
