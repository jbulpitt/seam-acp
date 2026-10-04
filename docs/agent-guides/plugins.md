# Built-in plugins

The controller loads `plugins/builtins.ts` in order, independently of Seam MCP.
Only known built-ins are loaded. The controller also installs thread naming
and optional service status through controller-only capability bootstraps.

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
survives a controller restart. Durable permission/config-proposal records are a
separate follow-up; this registry does not own their storage or expiry policy.

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
