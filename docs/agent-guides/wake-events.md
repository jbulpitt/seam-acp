# Agent-scheduled wake events (#59)

Moved from `AGENTS.md`: implementation notes for the wake mechanism. For *using* wakes, see the primer (`README.md`).


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
cap) live in `src/core/wake/types.ts`.

Implementation: `wake_events` table (`session-store.ts`), the DB sweeper
`src/core/wake/manager.ts` (D11 — poll, don't arm timers), and delivery through
the shipped dispatch queue (`fireWake` → `enqueueDispatchSpec` → `DispatchWatcher`
→ `dispatchInjectTurn`, ledgered as `kind: "wake"`). Pending wakes are visible
and cancellable via `/seam workflows` (and `/seam workflows cancel-wake:<id>`).

