# Native AGY capability fixtures

These fixtures freeze the R1 behavioral contract for Seam's primary, native
`agy` adapter. They do not describe the separately named optional
`agy-package` adapter.

`provenance.json` is authoritative for the evidence level and runtime stamps.
The trace field names and cumulative planner updates are a sanitized replay of
the observed native `StreamAgentStateUpdates` subset documented in
`packages/adapters/src/agy-stream.ts`; every identifier, path, token count,
message, tool payload, and binary byte in this directory is synthetic.

The fake CLI exposes the same local health, model, and Connect streaming routes
the production native adapter calls. Tests therefore execute the production
native profile, in-process ACP facade, `AgentRuntime`, attachment mapper,
structured-output envelope parser, and status-card renderers. The helper does
not contact a provider, read a user conversation, or claim model correctness.

Unknown fields remain opaque fixture data. In particular, tool payload bodies
and binary attachment bytes are never reinterpreted as thinking or visible
model text.
