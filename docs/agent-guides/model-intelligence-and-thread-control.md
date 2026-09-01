# Models & cross-thread session control

Canonical guide for agents choosing models or reconfiguring another Seam thread.
These seam-MCP tools are available in every channel with no per-project setup.
The metadata and thread controls are provider-agnostic; the clearly marked
`model_value_rankings` tool is Copilot-specific.

Consuming projects pin this raw URL:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/model-intelligence-and-thread-control.md`

There are two capability families:

1. **Model intelligence data** — cached, fast, read-only lookups of model
   benchmarks, pricing, and cost-efficiency ("value") rankings.
2. **Cross-thread session control** — reconfigure or reset *another* thread's
   agent / model / reasoning effort from your own thread.

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

## 2. Cross-thread session control

These mutate **another thread's** live session, scoped to your own channel — the
same trust boundary as `steer` / `handoff` (any agent in the channel may call
them; the target must be a thread in your channel). They compose naturally with
the data tools: read `model_value_rankings`, then apply the winner.

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
  silently sent. (Get a model's valid tiers from `valid_effort_tiers` in
  `model_value_rankings`, or the metadata tools.)

### `reset_thread_session(thread)`
Start a fresh session on a thread, keeping its current agent + model. Clears
conversation context. Use to recover a wedged/confused thread without changing
its model.

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
#134 (metadata cache); drain-safety fix #137. Merged 2026-09-01._
