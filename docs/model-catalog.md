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
`effort`. Core validates the SHAPE and renders it; it never interprets a
provider's model names.

Two rules make this safe to persist and ship:

- **Structured, not prose.** Evidence is never encoded into a human-formatted
  string or into `compatibility`.
- **No secrets, structurally.** The field set is closed — there is no free-form
  key/value map — and every text field is length-bounded. A record therefore
  cannot carry a credential, token, secret-bearing path, raw environment value,
  or user PII into a durable snapshot that is then shipped over the bridge and
  rendered in diagnostics. `scopeRef` is a non-secret scope fingerprint.

Per-model fields participate in the canonical checksum and diff, so a
description- or evidence-only change publishes a new generation. They survive
SQLite serialization, bridge RPC, and the metadata/value enrichment join, which
reads the catalog and writes a separate store rather than writing back.

Malformed *known* evidence fields fail closed and retain the prior generation;
*unknown* fields are tolerated so a snapshot written by a newer build is not
corrupted by round-tripping through an older one.

## Schema evolution and durable snapshots (#236)

Loading accepts a schema RANGE
(`MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION`…`MODEL_CATALOG_SCHEMA_VERSION`)
and normalizes older rows forward through `upgradeCatalogCandidate`. Accepting
only the current exact version meant the next bump would discard every durable
last-known-good snapshot and turn a deploy into a cold-cache outage. Prefer
additive optional fields (as `description` and `evidence` are) so no bump is
needed at all; when one is unavoidable, extend the upgrade hook rather than
widening the version check.

## Honest defaults (#236)

A publishable catalog still requires exactly one default row, but the generic
helper no longer *invents* one: if the configured `defaultModel` does not
resolve to a published row, candidate construction fails and the previous
generation is retained. Silently promoting row zero meant a thread could start
on whichever model happened to sort first.

An adapter may publish a literal unresolved alias row (`id`/`runtimeId` =
`default`). A separately established resolution belongs in that row's
`evidence.resolvedModel` — informational only. It must never rewrite the raw
binding, so the alias and the canonical row it names coexist without an
ambiguous reverse binding (generic validation refuses one that collides).

## Small-catalog reduction quarantine (#236)

The service — not provider parsing — compares each candidate with the durable
active generation. A candidate that both drops a published model id **and**
ends up smaller is held:

- **small catalogs** (at or below `smallCatalogMaxModels`, default 3): any net
  loss, which is the 2→1 and 3→1/2 case;
- **larger catalogs** (from `collapseMinModels`, default 4): the proportional
  more-than-half collapse rule.

Additions, metadata-only edits, and same-size swaps are never held: a swap keeps
coverage and is not the shape of a truncated fetch. A held candidate publishes
after a second **independent, identical** refresh; a different or *failed*
observation in between resets the confirmation. An operator can admit one
explicitly with `/seamadmin catalog refresh agent:<…> accept-reduction:true`,
which is bounded to that single refresh and never persisted. The refresh output
names what was held and how to admit it.

Thresholds are configurable and contain no agent-id branches, so a legitimate
provider retirement never needs a provider-specific exception.

## Shared bounded probe lifecycle (#236)

`runBoundedProbe` in `packages/adapters/src/probe-process.ts` is the one
child-process lifecycle for stdio/ACP collectors. The adapter supplies the
executable, argv, cwd and env and does its own protocol work in `run`; the
helper knows no agent, CLI, or model name, and never writes to the child, so a
catalog probe cannot spend model tokens.

On every exit path — success, spawn error, early exit, protocol error,
malformed output, timeout, cancellation — it runs registered close steps
(session/connection) in reverse order, clears timers and listeners, sends
SIGTERM then a bounded SIGKILL, and **awaits the child's exit**, so a returned
probe never leaves a process still dying. `run` is only invoked once the child
has actually spawned: Node reports ENOENT asynchronously, so without that a
probe against a missing executable would report success. Errors carry the
child's own stderr tail, bounded, and never the environment.

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
