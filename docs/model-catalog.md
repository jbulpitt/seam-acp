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
the actual process is spawned by the bridge. A binding
with no valid generation reports `warming`; selection fails closed. Runtime ACP
configuration is execution evidence only: if a live config option contradicts
the catalog's raw effort binding, Seam reports runtime/catalog drift and refuses
to claim success.

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
session authorities from returning to core selection consumers.
