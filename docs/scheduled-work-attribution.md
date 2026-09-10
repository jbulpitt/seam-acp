# #253: scheduled work attribution without changing busy

Stack: #268 → #269 → #271 (`5e89e573ade7a327c608789d2c60acbf358c0e85`)
→ this change. It adds live metadata, not another durable scheduler or a new
claim of provider restart recovery.

## Surfaces and privacy

- `threads()` keeps its existing `busy`/idle routing semantics. A separate
  scheduled-activity section identifies permitted occurrences by schedule id,
  occurrence id, owning thread, mode, phase, start time and elapsed duration.
- Scope comes from the token-resolved caller, never an arbitrary channel input.
  Both frozen and current thread-parent membership must match. The MCP renderer
  additionally intersects work with its permitted, non-deleted sibling list.
  A moved/deleted thread fails closed. Other channels contribute only to an
  aggregate count, never names, thread IDs or task content. A scoped idle list
  explicitly does not claim global idleness.
- `/seamadmin debug work` is a read-only global view. It rechecks the existing
  stamped-config-admin gate (speaker identity enabled, actual Discord user id
  allowlisted), responds ephemerally, and never permits agent-supplied global
  scope. Overflow is an in-memory metadata attachment, not a host-file read.
- Both server-status renderers display aggregate occurrence counts only. Turn
  accounting tokens remain separate: one live scheduled occurrence can own an
  outer token and a nested queue token. No global logical-job total is inferred
  by subtracting unrelated counter categories.
- Restart drain logs include up to 20 schedule/occurrence/thread IDs plus mode,
  phase and elapsed time, with the full aggregate count. Names, prompt/output,
  ACP IDs, provider identity, credentials and working directories are absent.

The activity registry admits an explicit metadata whitelist before the first
asynchronous precondition. It spans startup, queue wait, provider work, isolated
runtime disposal, output delivery and speech/final cleanup. Release is idempotent
and cannot remove another registration for the same logical occurrence. The
drain token is released even if metadata registration/release fails.

`InjectTurnOptions.lifecycle.onCleanup` is optional and observational. It runs
before isolated runtime disposal, including setup/prompt failure. A callback
failure cannot prevent disposal or alter #250's outcome ownership. Existing
ingest lifecycle users need not opt in.

## Evidence and boundaries

The pre-change production-path test held an isolated scheduled provider prompt:
global active turn count was one, the live thread was idle, but no scoped activity
projection existed. Tests now identify that exact occurrence while preserving
idle, exclude foreign/moved-thread details, hold startup/cleanup/output phases,
distinguish a live schedule's two drain tokens from one occurrence, and check
success/failure release and global-admin refusals. Command-budget and both status
renderer tests protect the new read surface.

Cron continues during drain. No scheduler, cancellation, handoff-routing, account,
runtime configuration or AGY policy changes are bundled here. Tests use temporary
SQLite and synthetic transport only; no production signals or provider prompts.
Real session reload and supervisor ordering remain #250's separate release gates.
