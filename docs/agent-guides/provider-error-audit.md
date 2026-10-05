# Provider failure boundaries

The observed cases and responses are recorded in [issue 711](https://github.com/jbulpitt/seam-acp/issues/711).
Classification lives in adapters; recovery consumes their verdicts.

## Observed rules

- Codex capacity, 2026-09-27: `Selected model is at capacity. Please try a different model.` arrived as the entire ordinary reply. It is overload, not an answer.
- OpenAI rollout, 2026-09-28 and dispatch `003a288c`: `{"type":"error","error":{"message":"model 'gpt-6.1-sol' is not enabled in rustponsesapi","type":"invalid_request_error","param":null,"code":null},"status":400}` arrived as the entire reply. Only that message shape with HTTP 400 and `invalid_request_error` is transient. `model_not_found` remains permanent, including inside a typed failure.
- Claude: the recorded ACP `data.errorKind: server_error` and HTTP 529 overload responses are transient. The existing refresh-contention and expired-auth signatures still take precedence.

## Carriers

- For dispatch `003a288c`, the recorded Codex event at `2026-10-05T00:43:20.876Z` is `task_complete.error`, with the rollout JSON as `error.message` and `codex_error_info: "other"`. It is not an ordinary assistant answer. The controller ledger nevertheless records `completed` at `00:43:20.897Z` with that JSON as output. Codex ACP's `handleFailedTurn`/`recordTypedSessionFailure` exposes this event through AIR when negotiated; `other` maps to its `provider_error` policy.
- Codex ACP 2.0.1 and Claude ACP 0.84.0 support AIR `sessionFailure`. Seam declares `_meta.jetbrains.air: { version: 1, capabilities: ["sessionFailure"] }` in the runtime initialize request. Catalog probes are unchanged.
- The agent advertises support in the initialize response's top-level `_meta`. Failures appear on `session_info_update` and, canonically, on the terminal `session/prompt` response. That response still says `end_turn`; Seam converts error-severity metadata to a classified failure before completion. Warning updates do not terminate a turn.
- AIR carries the agent's category, severity, title, details and actions. Seam retains those facts, plus any provider response, code and HTTP status. `limit` with `retry` is throttling; without it, quota requires user action. `access` with `login` goes to existing reauth negotiation.
- For a Codex wrapper that does not negotiate AIR, only a leading exact capacity sentence or a whole provider error envelope is held until the reply ends. Ordinary prose, fenced examples and replies from AIR-capable agents are not parsed as errors. The controller and adapter-child use the same decoder.
- Other agents keep their existing ACP-error and process-exit classifiers. No new text rules for Copilot, Grok or agy are inferred from unavailable raw causes.

## Ownership and budget

The adapter-child interprets a failed terminal response before bridge-owned rung-1 completion. It retains the same child and ACP session, sends only continuation prompts, and keeps the raw final error in the durable result for restart adoption.

Overload/server retries use 10s, 30s, 2m, 5m and 7m backoffs with a 15-minute horizon from the first failure. Provider time counts too; a delayed backoff cannot submit after the horizon. A running provider operation is not killed at the deadline. Other retry-kind schedules stay unchanged. Boot acquisition uses the same schedule with a 30s minimum, respecting the router's existing start cooldown, and preserves classification through suspension wrappers. Exhaustion never grants an outer owner another budget.

Quota stops automatic recovery with a precise paused notice containing the provider cause; the session remains available for an explicit retry after reset or top-up. Auth stays on the existing reauth path. Neither creates an automatic retry loop. Final transient exhaustion is a failed outcome with the provider error, never a successful error-text answer.
