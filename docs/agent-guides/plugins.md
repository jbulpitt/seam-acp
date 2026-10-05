# Built-in plugins

The controller loads `plugins/builtins.ts` in order, independently of Seam MCP.
Only known built-ins are loaded. The controller also installs thread naming,
card visuals, quota and optional service status through controller-only bootstraps.

A descriptor declares its id, API version, built-in/internal eligibility,
optional config validation and activate/dispose hooks, and contributions.
Load, validation or activation errors disable only that plugin and log the
original error. Duplicate ids or contribution routes are rejected without
publishing any of the rejected plugin's contributions.

Plugins receive their scoped logger and validated config, not the orchestrator,
router or stores. A fence invocation adds only the closed fence, filename
counter, original unfinished/watchdog notice, and an ordered output sink:
`sendText`, optional `sendFile`, and `fallback` to source. Contribution
instructions feed the harness preamble from the same registry as rendering.

Math registers `latex`, `math`, `tex` and `katex`. It owns the lazy MathJax/resvg
renderer and existing render bounds. Missing file output or rendering failure
uses source fallback. Handler exceptions log their cause and fall back without
ending the turn. Kernel framing, queues, delivery and recovery remain unchanged.

Plugin fence work is tracked; shutdown disposes plugins only after the existing
turn/output drains succeed, before closing platform resources. Disposal drains
in-flight fences and stops new contributions, and isolates disposal errors.

## Command and component contributions

Slash leaves declare their full command/group/leaf path, read-only or mutating
access, authorization, options, autocomplete and help. One list feeds the
registration JSON, dispatch, autocomplete and help. Registration checks sibling
uniqueness, required-option order, the 25-slot limit and Discord's 8,000-character
budget. The kernel applies participant, channel-lock and admin gates before
invoking a plugin. Invocations expose option readers and ephemeral replies, not
the Discord interaction or client.

MCP contributions keep descriptor, availability, handler and instruction text
together. The authenticated caller determines availability for listing,
instructions and calls; a plugin never chooses another caller. Server admission,
scope, authorization and JSON-RPC errors remain in the kernel. The MCP server
mounts only with `SEAM_MCP_ENABLED`; events and slash commands do not depend on it.

Components declare a custom-id namespace, accepted types and persistent or
collector lifetime. The same list classifies and dispatches interactions.
Persistent handlers register at boot; collectors remain with their collector.
The naming editor uses an owner and deadline in its custom id, so its handler
survives a controller restart. ACP permission requests and config proposals use
persistent component routes backed by durable action-card records (#775); the
registry routes clicks, and the records own storage and expiry.

## Thread naming

The trusted identity registry publishes per-thread ordered, immutable `thread-created` and
`identity-changed` facts. Internal session-write notifications mark dirty
identities; successful operation boundaries publish the final resolved snapshot
and await naming. Coalesced writes do not publish intermediate candidate names.
Identity handlers log their own failures without preventing other listeners.
A pending Discord rename does not hold another thread's identity effects.

The built-in naming plugin owns automatic naming, `/seamadmin naming rename`,
the rule editor and `rename_thread`. It receives title/liveness/rename operations,
resolved identity values and siblings in creation order. Its bootstrap-only
internal facades read exact prefix boundaries, write `namePrefix`, project
session identities and read/save `thread-namer.json`. Ordinary session upserts
preserve the stored prefix. No plugin receives a store or router.

## Configuration and runtime transitions

`core/config-apply-plan.ts` and `core/runtime-transition.ts` are internal kernel
modules. The editor, slash config, preset application and MCP configuration use
them; no configuration plugin or public plugin API is introduced here.

`ConfigApplyPlan.prepare` returns the existing validated proposal diff, its
target, confirming actor and audit correlation, and runtime consequence. It
writes nothing until `apply` delegates to the audited mutation engine. Editor,
bulk config and preset application retain their existing write and rollback order.

`RuntimeTransition` owns live configuration and process retirement. Agent
changes replace the session; model replacement follows the catalog's application
mode, while effort changes preserve ACP context. Permission changes await the
existing Codex mode application. Committed identity effects still drive naming.
`thread-session-control.ts` retains the previous class and type import names.

## Maintenance jobs and storage

Maintenance jobs declare a name, base interval and `after-admission` phase.
The contribution owns its timer/cadence; the host supplies an `AbortSignal`,
starts it after dispatch admission, and stops/drains it in the manager barrier.
A failed start unpublishes only that plugin. These jobs cannot request turns;
durable wakes, watches and schedules remain in the kernel.

Storage paths are bound to the plugin namespace. Host-assigned aliases may
retain legacy files; plugins cannot choose aliases or another namespace.
Service status keeps `service-status.sqlite` and `service-status-card.json`
unchanged, including history and the pinned message. It owns the source list,
adaptive poller, Refresh component and both MCP tools. Its only internal facade
is the card transport; the kernel receives a cache-only read for canary diagnostics.
`SERVICE_STATUS_ENABLED` and `DISCORD_SERVICE_STATUS_THREAD_ID` keep their
existing precedence. MCP still mounts only with `SEAM_MCP_ENABLED`.

Repository, HTTP, attempt and bridge contributions are not public surfaces.
Attachment, wake, watch, choice and result fences retain their kernel handlers.

## Quota and turn activity

The quota built-in owns `/seam info usage`, `agent_quota`, the pinned quota
card and `seam-quota:` Refresh. Its maintenance job retains the existing
activity-based cadence, refresh bounds and stale-value policy.
`DISCORD_AGENT_QUOTA_THREAD_ID` and `QUOTA_STALE_RETENTION_MS` are unchanged;
the storage alias keeps `agent-quota-card.json` and its pinned message.

The kernel emits immutable `turn-started` and `turn-completed` facts once,
ordered per agent, with the turn id, timestamp, host binding and account id.
Recovery adoption emits completion, not another start. Emission never waits
for a listener; failures cannot veto a turn or prevent sibling observations.

Quota's internal-tier facades expose configured/thread binding snapshots,
`readUsage(binding)` and card transport. Only the usage facade reads profiles
or live connections, including agy's verified runtime and Grok's live read.
Provider failures retain their sanitized real cause and affect only that row.
MCP-off deployments keep the job, card, Refresh and usage slash command.

## Status-card decorations and config keys

Decorators receive a frozen snapshot of status, agent and model facts, plus
the resolved visual preferences. They return only an icon, thumbnail or style.
The kernel retains state, action, completion and durable projection. A failed
decoration logs its cause and leaves the plain card available.

Config keys declare a schema, default and description. Defaults are validated
at boot; changes are validated in the existing audited `ConfigMutationService`.
Session > thread > channel > default precedence stays in the router.

The card-visuals built-in owns brand icon resolution, full/simple selection,
the GIF catalog and `/seam config card|gif`. Its internal facade reads effective
visual settings and writes the two keys through the mutation service; it never
receives sessions or the router. The GIF manifest refresh is an after-admission
job, and rendering reads only its cache. `SIMPLE_CARD_GIF_MANIFEST_URL` and
`BRAND_ICON_BASE_URL` retain their existing defaults and precedence.
