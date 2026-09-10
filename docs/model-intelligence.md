# Model intelligence operations

Model intelligence enriches the accepted operational catalog; it never decides
which models can run. The coordinator captures the complete cache-only catalog
fleet, one validated Artificial Analysis snapshot, one validated GitHub Copilot
pricing snapshot, and the configured calculation scenario. Metadata and value
rows become visible together by one SQLite generation-pointer transaction.

## Triggers and lifecycle

- Startup arms the `0 */12 * * *` UTC Croner job and queues a non-blocking
  catch-up refresh. Durable rows remain readable while it runs.
- A catalog publication queues a cached-source re-enrichment. A binding-state
  change is represented in the fleet signature, so a later scheduled or manual
  pass reconciles readiness even without a model-generation change.
- `/seamadmin catalog refresh agent:<agent@host|all>
  refresh-sources:true` waits for coordinated source refresh and reports the
  generation, source freshness, coverage, and diagnostics.
- Overlapping catalog, startup, cron, and operator requests share one active
  refresh. A source-forcing request queues and awaits one forced follow-up.
- Shutdown stops admission, aborts source requests, drains the coordinator, and
  closes stores only after the drain. An aborted refresh neither publishes nor
  records a post-stop attempt.

## Matching policy

Runtime IDs and bindings are opaque. Matching creates a separate normalized
key from exact catalog IDs, display names, and declared aliases. Normalization
changes only case and punctuation; identity tokens such as `mini`, `fast`,
`preview`, provider, and version are retained. Duplicate exact candidates are
ambiguous rather than row-order-selected.

Artificial Analysis effort suffixes are accepted only when that exact catalog
variant supports them. The displayed default benchmark policy chooses the
highest supported published effort and records the selected source row; all
matched benchmark variants remain inspectable. Unknown effort vocabulary is
unresolved. A small source-specific Claude word-order exception set is the only
override registry; new releases require no source edit.

GitHub pricing is matched independently. Default and long-context tiers remain
distinct; the long-context row is selected only when total scenario input is
greater than the configured threshold. GitHub rates alone calculate Copilot
credits. A required missing cached-input or cache-write rate makes the row
unrankable.

Capability cohorts use deterministic tercile thresholds over the matched AA
Intelligence Index values in the captured Copilot variants. Ties are ordered by
opaque model ID and then variant ID. A cohort can legitimately move when the
catalog changes.

When one opaque ID exists in more than one capability/credential scope,
`model_metadata_get` requires the returned `variant_id`; an unscoped ID is
reported as ambiguous instead of silently choosing one host. Query results
retain every binding and its catalog generation/state.

## Persistence and diagnostics

Source attempts are independent LKG streams. A failure retains the successful
snapshot's original fetch time and marks it stale; it never stamps retained
records with the retry time. Refresh attempts, source snapshots, generation
inputs, scenario, matching status, affected IDs, and regressions are durable.
The rolling history retains the newest 96 source attempts per source, 96
refresh attempts, and 96 coordinated generations, plus any source snapshot
still referenced by a retained generation.

Every previously matched benchmark or usable pricing scenario that becomes
unresolved is named as a matching regression. A broad matching collapse holds
the active generation; a smaller loss publishes visibly degraded data. A later
successful match emits one recovery transition. Expected unbenchmarked rows
stay visible as per-row diagnostics without becoming runnable evidence.

The rankings card labels publication time, original source ages, scenario,
selected benchmark effort, generation, and degradation. MCP reads and card
renders are cache-only. Per-turn status cards deliberately contain no model
intelligence.

## Migration and rollback

Migration only adds `model_intelligence_*` tables. Existing `model_metadata`
and `model_value_snapshot` tables and card identity are retained. Until the
first real coordinated generation, legacy readers continue serving those rows;
the migration marker is `legacy-unknown` and invents no source timestamp.

Rolling back code leaves the legacy tables intact. Rolling forward again reads
the coordinated active pointer. Never hand-edit either cache. If source parsing
or matching degrades, inspect `/seamadmin catalog refresh ...
refresh-sources:true`, logs for `model intelligence`, and the stored diagnostics;
fix the parser/matcher and refresh through the same admin path.
