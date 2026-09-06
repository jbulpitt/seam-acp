# Upstream service status (`service_status`, `service_status_refresh`)

Two seam-MCP tools that tell you whether the services Seam depends on are
healthy. Use them **before** debugging Seam when an agent call starts failing —
a 500 from a model provider looks exactly like a bot bug from the inside.

Monitored sources (the ids below are the only accepted values on a given
deployment; unknown ids are rejected):

- `github` — GitHub, including Copilot and its model providers
- `anthropic` — Claude API and Claude Code
- `openai` — Responses, Chat Completions, Codex API, Codex Web, Codex in
  ChatGPT Desktop, VS Code extension
- `xai` — the official xAI RSS feed
- `google-ai-studio` — AI Studio / Gemini API surfaces
- `google-cloud` — Gemini Code Assist and the Vertex Gemini API
- `linkworks-ollama` — a **third-party synthetic probe**, not official Ollama
  Cloud status, and never to be presented as such. Registered **only when
  `OLLAMA_CLOUD_ENABLED=true`**. It exists as the ollama-shaped check for the
  ollama-cloud agent; when that agent is parked the source is omitted from the
  default `service_status()` set and is not fetched.

## `service_status` — cached, instant, no network

```
service_status()
service_status({ sourceIds: ["anthropic"], includeComponents: true })
service_status({ includeIncidents: true, includeHistory: true, historyLimit: 5 })
```

Reads the durable snapshot the refresh manager last committed. It performs no
network work and returns immediately, so it is always safe to call — including
in a tight loop while triaging.

Flags (all optional, all default to the cheap answer):

- `sourceIds` — narrow to specific registered ids. Omit for all of them.
- `includeComponents` / `includeAllComponents` — per-component detail, worst
  status first. Without `includeAllComponents` you get only the components Seam
  actually depends on.
- `includeIncidents` (default **true**) / `includeResolvedIncidents` — active
  incidents, optionally plus recently resolved ones.
- `includeHistory` — recent material transitions for the source.
- `componentLimit`, `incidentLimit`, `updateLimit`, `historyLimit` — every list
  is bounded; asking for more than the cap clamps rather than erroring, and a
  zero or fractional limit is rejected.

## Reading the answer: two independent axes

This is the part worth internalising. Each source reports **both**:

- `reportedStatus` — what the provider said. `operational`, `maintenance`,
  `degraded`, `unknown`, `partial_outage`, `major_outage`. `unknown` means the
  provider reported something Seam deliberately refused to grade, not "fine".
- `observation.health` — whether **Seam** can currently reach the provider:
  `ok`, `stale`, `fetch_error`, or `never_fetched`.

So:

- `reportedStatus: "major_outage"`, `observation.health: "ok"` → the provider is
  down and we know it. Stop debugging Seam.
- `reportedStatus: "operational"`, `observation.health: "fetch_error"` → the
  last thing the provider said was "fine", but we have not been able to confirm
  it since `observation.lastSuccessAt`. Read `observation.lastError`. This is
  **not** evidence that the provider is healthy right now.
- `observation.hasProviderData: false` → nothing has ever been fetched;
  `reportedStatus` is a placeholder.

`observation.providerStatusIsCurrent` is the short version: true only when
`health` is `ok`.

## `service_status_refresh` — bounded, live, awaited

```
service_status_refresh()
service_status_refresh({ sourceIds: ["anthropic", "openai"] })
```

Forces a live refresh and **waits** for it, so the result reflects fresh
upstream attempts rather than the snapshot you already had. Reach for it only
when the cached read is too old to act on.

What to expect in the result:

- `disposition` per source: `executed` (this call fetched), `coalesced` (another
  caller's in-flight fetch was shared), `rate_limited` (a short hard cooldown is
  still active — nothing was fetched), or `cancelled`.
- `succeeded` is `null` for `rate_limited` and `cancelled`: no attempt produced
  an outcome. A cooldown is not a failure, and `outcome` reflects that —
  `skipped` when nothing ran.
- `outcome` overall: `succeeded`, `failed`, `mixed`, or `skipped`.
- Partial failure is normal. One slow or broken provider returns its own `error`
  and `durationMs` while the others still succeed.

Parallel callers share one in-flight attempt per source, so several agents
asking at once cost one upstream fetch, not several.

## Constraints worth knowing

- The tools accept **only registered source ids**. There is no argument that
  takes a URL, a header, or a credential — the registry is compiled in, and
  `linkworks-ollama` is present only when Ollama Cloud is enabled. An unknown
  id is a clear validation error naming the registered ids, never an empty
  result.
- Every list is explicitly bounded, so output stays small enough to reason over.
- If a deployment has the subsystem disabled, both tools answer
  "not enabled on this deployment" rather than failing silently.
