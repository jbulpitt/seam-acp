# Operational model catalog

Issue #229 replaces Seam's static-picker, live-session, adapter-description,
and rebuild-only model lists with one host-scoped operational catalog. UI,
autocomplete, validation, runtime planning, isolated work, reconstruction,
vision routing, model metadata joins, and status/audit output read this catalog
only. A read path never spawns an ACP process or contacts a provider.

## Coordinated model intelligence (#249)

The full operator and matching contract is in
[`model-intelligence.md`](model-intelligence.md).

Metadata and value rankings are enrichments of this operational catalog, not
parallel availability catalogs. One coordinator captures the complete
ready/stale fleet view, the active Artificial Analysis source snapshot, the
active GitHub Copilot pricing snapshot, and the configured cost scenario. It
then publishes metadata and value rows behind one SQLite generation pointer.
MCP and the pinned rankings card read that durable generation only.
Turn status cards are unchanged: model intelligence is deliberately not added
to their per-turn surface.

External matching is automatic and deterministic: exact opaque ids, display
names, and catalog aliases are compared through punctuation/case normalization;
known effort suffixes are considered only against the catalog's model-specific
effort capabilities. Ambiguous matches and unknown effort vocabulary remain
explicitly unresolved. The matcher contains only a few documented spelling
exceptions and no release allowlist, so a newly advertised model does not need
a Seam deployment before it can be enriched.

Artificial Analysis and GitHub pricing have independent, rolling append-log source
snapshots with source URL, parser version, attempt time, success time, all
normalized records, and failure status. One source failure retains only that
source's LKG. A catalog publication re-enriches from cached sources; scheduled
and startup refreshes update both sources first. Operators can force that same
coordinated path with `/seamadmin catalog refresh … refresh-sources:true`.
The newest 96 attempts per source, refresh attempts, and generations are kept,
along with every source snapshot still referenced by retained generations.

The default value scenario is 8,000 uncached input tokens and 2,000 output
tokens. Cached input, cache writes, output, and the long-context threshold are
separate settings. GitHub pricing alone drives Copilot credits; an absent rate
needed by the scenario makes a row unrankable rather than inventing zero cost.
Pricing and benchmark effort selection are shown in cached diagnostics.

The migration is additive. Previous `model_metadata` and
`model_value_snapshot` tables are retained for rollback/history and continue to
serve until the first coordinated generation is published. A legacy marker is
recorded with `legacy-unknown` provenance; old independent timestamps are never
presented as a coordinated source capture.

## Ownership boundary

Each `AgentAdapter` owns a `catalog` source. Its synchronous `scope()` declares
the non-secret semantic scope before provider work, and `fetch()` fetches provider/CLI data,
normalizes models and model-specific effort capabilities, declares how a model
change applies (`live`, `reload`, or `freshSession`), and supplies exhaustive
normalized-to-raw bindings. Core knows no provider naming convention.

`scope.sharing: "binding"` explicitly keeps discovery and publication local to
one `agent@location`, even when an older observation shared a generation.
Native Claude live discovery uses this policy: the same config-directory label
(`default`, in particular) does not establish identical credentials or wrapper
capabilities on different hosts. A fresh validated observation migrates the
binding without changing session/model selections or disabling reduction guards.

The portable `encodeCatalogSelection` and `decodeCatalogSelection` helpers are
the reverse-binding seam reserved for #228. This base change preserves Agy's
current segmented, model-baked choices; it does not normalize Agy families or
effort suffixes.

Production sources are explicit for every registered profile:

- Copilot probes ACP model configuration and re-probes each model's available
  effort values and selected default. Extra credential profiles probe with the
  same credential-scoped environment as runtime spawn.
- Direct Anthropic Claude and extra direct credential profiles are **live-first**
  (#232): they probe ACP for the advertised model list and each model's own
  effort options, then re-add JSONL-verified canonical models the wrapper does
  not advertise as a `verified-overlay`. See "Direct Claude" below.
- Vertex Claude and Z.ai use validated manifests with verified context limits
  and **do not inherit the direct catalog**. Their scope includes
  credentials/backend and, for Vertex, project and region.
- Codex queries `model/list` through the exact configured
  `codex-acp cli app-server` runtime used for sessions. That live response exclusively controls
  operational availability, raw ids/aliases, per-model supported/default
  reasoning levels, and the live default. `~/.codex/models_cache.json` and a
  configured model manifest may enrich an already-advertised exact id with
  context metadata; neither can add or keep a selectable model.
- Agy reads its segmented language-server catalog and preserves `modelBaked`;
  a complete configured manifest remains usable when discovery is unavailable.
- Grok performs xAI discovery during refresh, never during startup readiness;
  configured manifests are the validated no-discovery strategy.
- Parked/optional Ollama Cloud uses its curated Codex manifest and a separate
  provider scope.

## Direct Claude: live base + verified overlay (#232)

Direct Anthropic is the one adapter where neither pure strategy is correct, so
it runs both and merges them in the Claude adapter
(`packages/adapters/src/profiles/claude-catalog.ts`). Core learns no Claude
naming convention.

**Why.** Measured on this subscription (2026-09-08, claude-agent-acp 0.73.0) the
wrapper advertises exactly `default, opus[1m], claude-fable-5-1[1m], sonnet,
haiku`. Five canonical models that are reachable and JSONL-verified —
`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-fable-5`,
`claude-sonnet-5` — are **absent** from it; Seam reaches them by forwarding the
canonical id through `ANTHROPIC_MODEL`. A live-only catalog would silently
delete five working models. A static-only catalog (the pre-#232 behavior) never
measures per-model capability — it would, for example, offer `haiku` an effort
level that model does not advertise.

**How.**

- The live ACP list is the operational base. Each advertised model is observed
  in its **own fresh session**, spawned with the same credential-scoped
  environment runtime spawn uses for that model. A session selects at most one
  model, so one model's state can never decide another's advertised default.
- Discovery **spends no model tokens**: it never sends `session/prompt`. Only
  `initialize`, `session/new`, one `session/set_config_option`, `session/close`.
- `CLAUDE_VERIFIED_OVERLAY` re-adds a verified canonical model **only when
  absent from ACP**, carrying verification date, wrapper and Claude Code
  version, credential scope, resolved model, context window, and effort
  evidence. Each published row records that in `provenance`
  (`acp-live…` or `verified-overlay; absent from ACP; …`).
- Merging is by **canonical identity**: `claude-fable-5-1[1m]` folds onto
  `claude-fable-5-1` (raw id kept as an alias), so live and overlay never
  publish the same model twice. The `[1m]` suffix is stripped only for full
  canonical ids — never for a bare alias, because stripping `opus[1m]` would
  mint `opus`, which the model-management runbook records as fuzzy-resolving to
  a different family.
- **The overlay is scoped to the credential set that proved it.** Each entry
  records the credential scope its JSONL verification was captured on, and is
  published only on a refresh running under that scope. An alternate credential
  profile therefore publishes only its own live list — fail closed, rather than
  inheriting evidence nobody measured there.
- **Context windows are scope-truthful.** A row's window comes ONLY from a
  verification captured on the ACTIVE scope. ACP reports no context window at
  discovery, so a live row without matching-scope verification publishes a null
  window and says so. A live-observation record therefore never carries a
  `context`: the window travels on the verified record that established it,
  rather than a global table's default-account value being relabelled as an
  alternate scope's live measurement. That record is published on **every** row
  the overlay contributed to, including one whose identity the wrapper resolved
  for itself (`claude-fable-5-1[1m]` → `claude-fable-5-1`) — self-resolution
  decides only what the live record may claim, never whether the verification
  behind the window stays visible. A live observation alone never substantiates
  a context window.
- **The probe reproduces the runtime spawn exactly**: same executable, same
  credential-scoped environment, the same cwd a real turn uses, and the
  **canonical** model id both in `ANTHROPIC_MODEL` and in the in-session
  selection — because `runtimeId`/`rawModel` are canonical, so a catalog-backed
  turn calls `setModel(canonical)`. Selecting the raw advertisement instead
  (`claude-fable-5-1[1m]`) would measure effort and defaults after a selection
  runtime never performs. An alias canonicalizes to itself and is not selected
  by the environment, so it is still selected explicitly, once, per session. Using the
  runtime cwd rather than a temp directory makes a refresh noticeably slower —
  the wrapper scans the project on session start — which is the accepted cost
  of observing what a real turn observes.
- **The bounded lifecycle is the shared one** (`runBoundedProbe`, #236): bounded
  output, phased session-before-connection close with an AbortSignal, sealed
  registration, SIGTERM→SIGKILL with an awaited exit, redacted structured
  errors, and cancellation. The collector keeps no private timeout or cleanup
  path to drift from it. The connection phase ends the transport and awaits it:
  `ClientSideConnection` exposes no close, so an ACP connection IS its stream.
- **A clean exit is not a failure.** A code-0 exit with no signal is ordinary
  teardown — a short-lived wrapper ending after its work. Classifying it as
  `exited_early` failed probes that had already succeeded, purely on whether the
  exit event beat the run's resolution. Only an abnormal exit fails a probe.
- **Fanout is cancelled and drained, under one catalog deadline.** The first
  worker failure aborts its siblings through a shared controller **at the moment
  it fails** — not after the drain, which could no longer reach a sibling still
  running and left a mute wrapper holding its full session budget — and only
  then is every worker awaited (`allSettled`) so no session or child outlives
  the call. The caller sees the first genuine failure, not a sibling's derived
  cancellation. A
  single `overallTimeoutMs` bounds the whole collection; the per-session
  `timeoutMs` still bounds one session and is clamped by whatever catalog budget
  remains, so neither can silently widen the other.
- **Nothing is inferred from a label, a display name, an id substring, or a
  model's self-report.** Context windows come from the JSONL-verified table
  only; a live model with no verified window publishes a null window rather than
  a guess. When ACP echoes an alias back unresolved (measured: `default` →
  `default`), the row does not manufacture a resolution — it quotes the latest
  verified resolution with its provenance, or says the resolution is unverified.
- The **default** is the operator's configured `CLAUDE_DEFAULT_MODEL`, never the
  bare wrapper session's `currentValue` (measured: `sonnet`), which would
  silently move every new thread off the configured model.
- A probe failure **throws**, so `ModelCatalogService` retains the previous
  generation rather than overwriting good live data with a narrower guess. A
  wrapper release that temporarily stops advertising a verified model does not
  remove it: the overlay re-adds it.

Refreshing the overlay is a controlled, token-spending maintenance operation
(model-management runbook §4/§4a/§13), never part of a refresh. Inspect what a
refresh would publish, for free, with:

```bash
npm run build && node scripts/claude-catalog-probe.mjs --clean-env
```

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

- **Cross-row semantics at BOTH boundaries.** `assertCatalogSemantics` is the
  shared provider-neutral rule for identity that cannot be judged one field at a
  time: duplicate model ids, an id colliding with another row's alias, a reverse
  binding two rows both claim, and exactly-one-default. It lived only in core, so
  a colliding candidate crossed the bridge and was refused only after transport.
  Evidence is documented as a SET, so an exact duplicate record is rejected too.
- **Declared-VALUE policy over the whole graph.** `assertCatalogValues` gives
  every declared field an explicit type, format, range and content policy:
  scalar version/config/source fields refuse object and array substitutions;
  context windows must be positive SAFE integers within a generous documented
  ceiling (`CATALOG_MAX_CONTEXT_TOKENS`, two orders of magnitude above anything
  shipping today) — no NaN, infinity, fractional, negative, or precision-losing
  values; adapter versions are positive safe integers under
  `CATALOG_MAX_ADAPTER_VERSION`; `sourceVersion`/`cliVersion` keep their declared
  string format rather than accepting numbers or objects; aliases, models,
  modalities,
  service tiers, effort choices and bindings have cardinality and item-size
  bounds with duplicate detection; enums are closed; and no field outside the
  scope identity family may contain control characters, PII, credentials,
  token-shaped strings, or an absolute/home/secret-bearing path.
- **Scope labels are diagnostic; identity is the fingerprint.**
  `credentialProfile`, `backend`, `project`, `region` and `policy` legitimately
  carry host-shaped values in production, so refusing them would fail every real
  refresh and take the catalog cold. Codex uses a bounded digest of the
  app-server account identity rather than a filesystem location. An unsafe
  label is replaced with the CONSTANT sentinel
  `[redacted]`, or omitted. It is deliberately **not** derived from the input: a
  truncated digest of a low-entropy value like a home directory is
  dictionary-reversible, which would leak the very path the replacement exists
  to remove. Nothing keys off the label, so a constant costs nothing.
- **The adapter-produced `fingerprint` is never rewritten.** It is validated for
  safe format (a digest, or a bounded safe identifier) and otherwise refused —
  silently changing it would fork the scope and split its generation history.
  Scope distinctness therefore survives label redaction intact.
- **Not in this issue:** a salted/HMAC scheme that could keep labels distinct
  *and* non-reversible is deliberately out of scope for #236 and tracked as
  follow-up hardening, along with threat models beyond validated adapter output.
- **Normalization never mutates its input.** Adapters memoize their scope object
  (and `asRemoteCatalogAdapter` memoizes the whole candidate) while the service
  deep-freezes what it publishes, so an in-place sanitizer would throw on the
  second refresh. `normalizeCatalogCandidate` returns a copy of only what it
  must change.
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
- **The config audit trail**: `ConfigMutationService.effectiveSnapshot` records
  the catalog state, generation, source, and the selected model's description
  and rendered evidence, so an audit entry can still explain a model choice
  after the catalog has moved on.
- The **metadata enrichment join** carries the catalog-owned description AND the
  structured evidence, in its validated bounded representation, deduplicated by
  canonical identity across agents advertising the same model and persisted in
  the metadata cache.

The turn status card does not display catalog descriptions or evidence. Its
existing model identity, activity, and thinking output remain unchanged.

MCP configuration output and the config audit trail format through the shared renderer in
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
- **Settlement of `run` — not a fixed grace — is the authority for when
  registration is complete.** On the deadline/abort path the helper aborts
  `handle.signal`, then waits for the run to actually settle before closing the
  registration phase and draining every registered close. A fixed grace was the
  wrong authority: a registration that landed after it was fired detached, so
  the helper could return while a session close was still pending.
  `finalizeDeadlineMs` is only a ceiling so an uncooperative run cannot hang the
  helper forever; hitting it terminates and reaps the child and then returns
  `not_settled`.
- **Registration phases are explicit, and late steps obey them.** While the
  phase is open a step is QUEUED with its declared phase and drained by the
  phase loop — never executed on arrival, which previously discarded the phase
  and could run a connection close before a session close. The loop repeats
  until a full round adds nothing new, then SEALS. A registration after the seal
  is refused outright: not executed, not detached, so nothing acts after return.
- **What "bounded" means, exactly.** Each close step is handed an `AbortSignal`
  and a bounded window; a cooperative step observes it and stops, and the helper
  AWAITS it before returning. The helper cannot preempt arbitrary JavaScript that
  ignores cancellation — no mechanism in the language can — so a deliberately
  non-cooperative callback may still mutate state after its promise is
  abandoned. That adversarial case is outside this contract. What IS guaranteed:
  every close implementation in this repository cooperates (enforced by test),
  and the helper itself schedules no work after return.
- **Pre-spawn and post-spawn `error` are different things.** Before a pid exists
  an `error` is `spawn_failed`. After one exists the process is real and may
  still be running, so it is a `protocol_error` that must still be terminated
  and reaped; if no exit is observed the result is `not_reaped`. Classifying it
  `spawn_failed` both misdescribed it and skipped the reaping question.
- **Only an observed `exit` counts as reaped**, and `not_reaped` outranks every
  other cause — a leaked process is the most actionable fact there is.
- **A protective `error` listener is attached for the whole lifecycle and
  removed last**, so an error emitted during teardown cannot become an uncaught
  exception in the host (or an unhandled error in a test run). All other
  listeners — including both mutually raced pairs, `spawn`/`error` and
  `exit`/`error` — are removed on every path.
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
