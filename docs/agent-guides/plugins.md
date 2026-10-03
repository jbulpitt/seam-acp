# Built-in fence plugins

The controller loads `plugins/builtins.ts` in order, independently of Seam MCP.
Only known built-ins are loaded. This wave supports fence contributions only.

A descriptor declares its id, API version, built-in/internal eligibility,
optional config validation and activate/dispose hooks, and fence contributions.
Load, validation or activation errors disable only that plugin and log the
original error. Duplicate ids or fence tags/aliases are rejected without
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

Commands, MCP, components, events, storage and jobs are not contribution types
yet. Attachment, wake, watch, choice and result fences retain their current
handlers.
