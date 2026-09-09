# Operational model catalog

Issue #229 replaces Seam's static-picker, live-session, adapter-description,
and rebuild-only model lists with one host-scoped operational catalog. UI,
autocomplete, validation, runtime planning, isolated work, reconstruction,
vision routing, model metadata joins, and status/audit output read this catalog
only. A read path never spawns an ACP process or contacts a provider.

## Ownership boundary

Each `AgentAdapter` owns a `catalog` source. Its synchronous `scope()` declares
the non-secret semantic scope before provider work, and `fetch()` fetches provider/CLI data,
normalizes models and model-specific effort capabilities, declares how a model
change applies (`live`, `reload`, or `freshSession`), and supplies exhaustive
normalized-to-raw bindings. Core knows no provider naming convention.

The portable `encodeCatalogSelection` and `decodeCatalogSelection` helpers are
the reverse-binding seam reserved for #228. This base change preserves Agy's
current segmented, model-baked choices; it does not normalize Agy families or
effort suffixes.

Production sources are explicit for every registered profile:

- Copilot probes ACP model configuration and re-probes each model's available
  effort values and selected default. Extra credential profiles probe with the
  same credential-scoped environment as runtime spawn.
- Claude, extra Claude profiles, Vertex Claude, and Z.ai use validated manifests
  with verified context limits. Their scope includes credentials/backend and,
  for Vertex, project and region.
- Codex reads its bounded host-local model cache unless an operator manifest is
  pinned, preserving per-model supported/default reasoning levels plus native,
  maximum, and effective context data from that cache.
- Agy reads its segmented language-server catalog and preserves `modelBaked`;
  a complete configured manifest remains usable when discovery is unavailable.
- Grok performs xAI discovery during refresh, never during startup readiness;
  configured manifests are the validated no-discovery strategy.
- Parked/optional Ollama Cloud uses its curated Codex manifest and a separate
  provider scope.

Remote bridges expose adapter-owned `describeModelCatalog` (scope-only) and
`fetchModelCatalog` RPCs. The core
service applies identical generic validation and persistence to local and remote
candidates; adapter-specific validation runs on the host before an RPC result is
returned.

## Per-model description and evidence (#236)

A normalized row may carry an optional `description` and an optional `evidence`
array of structured, provider-neutral provenance records. Candidate-wide
`source`/`sourceVersion` still describe the fetch as a whole, but they cannot
represent a catalog whose rows have *different* origins — a live-advertised
model beside one carried forward from an out-of-band verification.

Each record declares `kind` (`live-observation`, `verified-record`,
`declared-manifest`, `enrichment`) and a `source`, plus optional `observedAt`,
`runtimeVersion`, `adapterVersion`, `scopeRef`, `resolvedModel`, `context`, and
`effort`. Core validates and renders; it never interprets a provider's names.

**One portable validator, applied at two boundaries.**
`packages/adapters/src/catalog-evidence.ts` is the single screen. It runs
**before a remote bridge returns a candidate** and **again before core persists
or loads one** — a remote host is not a trust boundary we can defer past, so
malformed or secret-bearing content never crosses the wire in the first place.

What it enforces:

- **Exact-key closure over the WHOLE normalized graph.** `assertClosedCatalogShape`
  declares the complete key set for the candidate, `scope`, every model row,
  `context`, `modalities`, `effort`, each effort choice, each binding, and every
  evidence record and its nested `context`/`effort`. An unknown key at ANY of
  those levels is a rejection, not a passthrough. Closing only
  description/evidence left the rest open, so an undeclared key — including a
  50 KB payload — crossed the bridge and was persisted inside schema 1.
- **Content screens, because length is not sanitization.** A 40-character token
  fits every bound. Free text (`note`, `description`) is screened for
  assignments, bearer tokens, credential words, key prefixes, JWTs, PEM blocks,
  long opaque runs, e-mail addresses, home paths, and credential-bearing paths.
  Identifier/label fields (`source`, `runtimeVersion`, `resolvedModel`, methods,
  effort choices) are constrained by a **charset** that cannot spell `KEY=VALUE`
  at all, so a legitimate raw model id such as `vendor::nebula@2026` is accepted
  while an environment fragment is not.
- **`scopeRef` must be a scope fingerprint or a short sanitized identifier** —
  never a path, URL, or account.
- **Bounds on lists and items**, and **semantic consistency**: a context window
  that exceeds its own maximum, or an effort default that is not among its own
  choices, is rejected.

### Array semantics

Per-model fields participate in the **canonical** checksum and diff, so key
insertion order is never an authority. Array order is defined per field:

- **`evidence` is an unordered SET.** It is re-emitted in a canonical **total**
  order — `kind`, then `source`, then `observedAt`, then the full canonical
  serialization of the record as the final tiebreaker. The tiebreaker is
  load-bearing: without it two valid records agreeing on the first three keys
  kept their input order, so the transport order of an evidence array leaked
  into the content checksum, the per-row diff, and the reduction-confirmation
  fingerprint.
- **`models`, `effort.choices`, and `bindings` are ORDERED sequences** whose
  order is provider-meaningful (preference order, display order, and the codec
  rows derived from them). They are preserved as given, and reordering them is a
  real change that surfaces as one.
- `aliases`, `serviceTiers`, and `modalities` are preserved as given; their
  contents are uniqueness-checked, and no consumer treats their order as
  meaningful.

### Surfaces that carry it

`SessionRouter.describeConfig` is the shared **input** the operator-facing
surfaces read — it is not itself an output. The surfaces are:

- **MCP `config_describe`** renders a `model info` line plus one line per
  evidence record.
- **The turn status card**: `TurnStatus` → `StatusPanelInput`/`StatusPanel` →
  the Discord renderer's `Model info` field (full cards only).
- **The config audit trail**: `ConfigMutationService.effectiveSnapshot` records
  the catalog state, generation, source, and the selected model's description
  and rendered evidence, so an audit entry can still explain a model choice
  after the catalog has moved on.
- The **metadata enrichment join** carries the catalog-owned description.

All three operator surfaces format through the one renderer in
`packages/core/src/core/catalog-evidence-render.ts`, which bounds both the
number of lines and each line's length. Every read is cache-only.

## Schema evolution and durable snapshots (#236)

Loading accepts a schema RANGE
(`MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION`…`MODEL_CATALOG_SCHEMA_VERSION`)
and normalizes older rows forward through `upgradeCatalogCandidate`. Accepting
only the current exact version meant the next bump would discard every durable
last-known-good snapshot and turn a deploy into a cold-cache outage. Prefer
additive optional fields (as `description` and `evidence` are) so no bump is
needed at all; when one is unavoidable, extend the upgrade hook rather than
widening the version check. A malformed stored row is ignored, never deleted;
a malformed *refresh* candidate retains the active generation.

## Honest defaults (#236)

A publishable catalog requires exactly one default row, and nothing invents one.

- `manifestCatalogSource` resolves the configured default by **exact model id**,
  or failing that by a **declared alias** on exactly one row. Two rows claiming
  the same alias is ambiguous and fails rather than guessing.
- `asRemoteCatalogAdapter` no longer falls back to `models[0]`; a remote
  candidate that does not declare exactly one default fails closed.
- An adapter may publish a literal unresolved alias row (`id`/`runtimeId` =
  `default`). A separately established resolution belongs in that row's
  `evidence.resolvedModel` — informational only. It must never rewrite the raw
  binding, and a row that does collide is refused as an ambiguous reverse
  binding.

## Small-catalog reduction quarantine (#236)

The service — not provider parsing — compares each candidate with the durable
active generation.

- **Small catalogs** (at or below `smallCatalogMaxModels`, default 3): **any
  removal** is held, including a same-size replacement `{a,b}` → `{a,c}`. A
  provider with two or three models has no margin, and a same-size swap is
  indistinguishable from a partial fetch that substituted a placeholder.
- **Larger catalogs** (from `collapseMinModels`, default 4): the proportional
  more-than-half collapse rule.
- Pure additions and metadata-only edits are never held.

Publication requires a second **independent, identical** observation. The
confirmation identity is a **substantive fingerprint** that excludes volatile
`observedAt`/`fetchedAt`, because two genuine observations of the same reduced
catalog differ only in when they were taken — a plain checksum would make
confirmation impossible.

Confirmation state is **typed and durable** (`model_catalog_reduction_quarantine`),
tied to the binding, the scope, the prior generation, the rule, and the removed
set. Only a matching prior reduction quarantine can confirm; an unrelated
attempt's recorded checksum cannot. It is cleared on **every** non-qualifying
attempt — offline/unavailable, drift, failure, or a different candidate — so
`quarantine → offline → identical candidate` quarantines again rather than
publishing.

`/seamadmin catalog refresh <agent@host> accept-reduction:true` is the bounded
operator override. It **rejects `agent:all`** (one click must not admit every
simultaneous fleet reduction), applies to a single refresh of a single binding,
is never persisted as a setting, and is recorded durably as
`published-accepted-reduction` with the accepting operator, so an audit can tell
a bypass from an ordinary publication. The refresh response names what was held
and how to admit it.

## Shared bounded probe lifecycle (#236)

`runBoundedProbe` in `packages/adapters/src/probe-process.ts` is the one
child-process lifecycle for stdio/ACP collectors, and it is **enforcing**, not
advisory. The adapter supplies executable, argv, cwd and env and does its own
protocol work in `run`; the helper knows no agent, CLI, or model name, and never
writes to the child, so a catalog probe cannot spend model tokens.

- **stdout and stderr are bounded at the stream boundary.** The helper owns the
  only consumer of the raw stdout and republishes a bounded view, so nothing is
  lost to a late listener and nothing can exceed the ceiling. Overflow fails the
  probe (`output_overflow`) and kills the child — a collector that never reads
  is still protected.
- **Close steps run in explicit phases: SESSION before CONNECTION**, never in
  registration order. A session is closed politely while its transport is still
  up.
- **A finalization barrier means return actually means cleanup happened.** On
  the deadline/abort path the helper aborts `handle.signal` first, then gives an
  already-running `run` a *bounded* `closeGraceMs` to observe the abort and
  finish registering its closes; late registrations are then drained to
  quiescence before the helper settles. A cooperative provider returns
  immediately — the grace is a ceiling, not a floor. Previously a late
  registration was fired detached, so the helper could resolve while a session
  close was still pending.
- **Only an observed `exit` counts as reaped.** `terminate` no longer resolves
  on `error`; a child that errors without exiting is reported `not_reaped`
  rather than returned as a clean success, and both mutually raced listeners
  (`spawn`/`error`, `exit`/`error`) are removed on every path.
- **`handle.signal`** aborts on every ending, so provider async work is
  cancelled too.
- **Errors are structured codes** (`spawn_failed`, `exited_early`,
  `output_overflow`, `timeout`, `cancelled`, `not_reaped`, `protocol_error`)
  with **redacted** detail. Raw child stderr is never persisted or rendered:
  every supplied env value and every credential-shaped pattern is stripped.
- **The exit is awaited**, and failing to observe one is reported as
  `not_reaped` rather than returned as a clean success.
- `run` is invoked only after the child has actually spawned: Node reports
  ENOENT asynchronously, so without that gate a probe against a missing
  executable reported success.

## Persistence and publication

`ModelCatalogStore` migrates four tables in the shared `seam.db`:

- `model_catalog_generations`: immutable, checksummed snapshot generations.
- `model_catalog_scopes`: the active-generation pointer per semantic scope.
- `model_catalog_observations`: agent/host observations, source and schema /
  adapter / CLI provenance, and drift diagnostics.
- `model_catalog_refresh_status`: the last attempt, including quarantined and
  failed candidates.

Publication is one SQLite transaction: insert a new immutable generation, switch
the active pointer, and write the binding observation. The in-memory frozen
snapshot changes only after that transaction commits. Generations are strictly
monotonic even when content returns from A to B and back to A. Empty, malformed,
incompatible, ambiguous, conflicting, or suspiciously collapsed candidates do
not overwrite last-known-good. A coverage collapse requires the same candidate
on two consecutive refresh attempts. Equivalent-scope disagreement quarantines
the disagreeing binding instead of contaminating its peer.

Offline remote hosts retain their snapshot and report it as `stale`. Remote-only
agent ids remain selectable and use a catalog-backed controller descriptor while
the actual process is spawned by the bridge. Preset application, stateless
workers, and isolated ingest carry the selected/authoring host through catalog
validation and dispatch; they never fall back to a same-named local profile.
A binding
with no valid generation reports `warming`; selection fails closed. Runtime ACP
configuration is execution evidence only: if a live config option contradicts
the catalog's raw effort binding, Seam reports runtime/catalog drift and refuses
to claim success.

Ordinary compaction selects the available catalog model with the largest
effective context window (declared default wins ties) and budgets transcripts
from that same record. The former per-provider `*_COMPACTION_MODEL` settings
and hardcoded context-window map are retired; leftover environment keys are
inert. The separate Premium Compact (Discord) pipeline retains its fixed,
catalog-validated analysis contract.

## Lifecycle and operations

SQLite snapshots are loaded synchronously. After Discord readiness,
`ModelCatalogService.start()` queues a non-blocking startup refresh and arms the
UTC cron (`17 */6 * * *`). Refreshes are bounded-concurrency and single-flight
per adapter-declared semantic scope, including the first cold fetch. A remote bridge ready event refreshes every
installed adapter on that host.

Every newly published generation notifies model metadata and model-value
enrichment. If either enrichment is already fetching, it queues one follow-up
pass so publication cannot leave a cold or stale join until the independent
12-hour cron. Enrichment has no fallback ACP probe and never determines
operational availability.

Operators can force a refresh with:

```text
/seamadmin catalog refresh agent:<agent@location|all>
```

The durable command response includes per-binding outcome, diff counts,
generation transition, semantic scope, source, fetch time, CLI provenance, and
the retained/quarantine error. It is handler-gated by
`SEAM_CONFIG_ADMIN_USER_IDS` in addition to `/seamadmin` visibility.

Shutdown stops admission, unsubscribes bridge refresh, drains admitted catalog
work within the shared shutdown budget, and closes the catalog store only after
a successful drain. Catalog refresh must never be added to request-time paths.

## Verification contract

The catalog tests use an intentionally alien fake adapter: unusual raw model
IDs, a nonstandard config-option ID, and effort names no core switch statement
could guess. Tests cover forward/reverse codec use, model-specific defaults,
immutable restart persistence, atomic failure retention, collapse quarantine,
scope single-flight, remote stale behavior, disagreement quarantine,
non-blocking startup, schema migration, all production profile sources, and the
manual command. An architecture test prevents the deleted picker/static/live
session authorities, provider-specific ingest allowlists, and summary-model
switches from returning to core selection consumers.
