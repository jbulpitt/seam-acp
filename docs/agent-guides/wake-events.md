# Agent-scheduled wake events

An agent can schedule its **own** one-shot future re-entry into its thread —
"wake me in N minutes and replay this prompt." This is the working substrate for
deferred self-follow-up; the **native `ScheduleWakeup` / `Monitor` tools do NOT
function over ACP** (nothing is emitted post-`end_turn`), so agents must use this
mechanism instead:

- **With seam-MCP:** `schedule_wake({ delaySeconds, reason, prompt })` →
  `{ wakeId }`, and `cancel_wake(wakeId)`.
- **Without MCP (e.g. agy):** emit a fenced block tagged `seam-wake` whose body
  is JSON `{ delaySeconds, reason, prompt }`. The bridge arms the wake and
  removes the block (same path the MCP tool wraps).

Semantics mirror upstream `ScheduleWakeup`: **one-shot** (fires once, then the
row is deleted), **durable** (survives `npm run redeploy`), delivered as a
**live** turn with the thread's context intact, and **self-renewing only if you
re-arm during the woken turn** — nothing repeats automatically. Delay floor 60s,
ceiling 7 days. Loop-safety backstops (min-delay, chain-depth cap, per-thread
cap) live in `packages/core/src/core/wake/types.ts`.

Implementation: `wake_events` table (`session-store.ts`), the DB sweeper
`packages/core/src/core/wake/manager.ts`, and delivery through
the shipped dispatch queue (`fireWake` → `enqueueDispatchSpec` → `DispatchWatcher`
→ `dispatchInjectTurn`, ledgered as `kind: "wake"`). Pending wakes are visible
and cancellable via `/seam workflows` (and `/seam workflows cancel-wake:<id>`).

Firing records a deterministic dispatch ID and deletes the wake in one SQLite
transaction. The watcher owns delivery, even without the ingress file. The
wake's status card shows **Waiting** behind a busy turn, then **Working** on
FIFO admission and **Done** on success, all on the same message. It replaces
the separate **⏰ Waking up** announcement.

Transient Discord lookups do not discard the wake; confirmed Unknown
Channel (10003), Discord locks and the existing catch-up policy still stop it.
