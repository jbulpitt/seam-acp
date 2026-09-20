# Build orchestration for epic #439

Read [`session-authority-manifesto.md`](./session-authority-manifesto.md) first. This
document is the *how*: which model runs which story, what order, and what will collide if
you ignore it.

## The operational constraint that dominates everything

Three files carry almost the whole epic:

- **`orchestrator.ts`** — 24,260 lines. Touched by #441, #445, #448, #450, #451.
- **`mux.ts`** — touched by #442, #443, #444.
- **`bridge/src/index.ts`** — touched by #442, #444, #453.

Run two stories against the same hot file concurrently and you get merge conflict or
duplicated work. That is not hypothetical: #432 and #433 were the same fix twice, filed
hours apart, because a worker was steered mid-flight while already building it.

**So the unit of parallelism is the lane, not the story.**

## Lanes

Serial within a lane. Parallel across lanes. Three lanes fits the four-thread worker pool
with one spare for review and verification.

### Lane A — `orchestrator.ts`

1. **#441** resolver extraction
2. **#448** ladder execution + removal of the over-restrictive retry guards
3. **#450** tiered presentation
4. **#445** status snapshot and card path
5. **#451** recovery context appended to `CONTINUE_PROMPT`

### Lane B — `mux.ts` and `bridge/src/index.ts`

1. **#453** copilot collapse — smallest, clears the deck before the big ones
2. **#442** bridge reports per-slot health
3. **#444** output log with cursors, plus line framing
4. **#443** hang detection

### Lane C — no hot-file contact, freely parallel

- **#455** metadata ingestion (blocks #449)
- **#440** adapter error normalization (blocks #441 — start this first)
- **#446** durable session-to-host binding
- **#449** fallback chain — after #455
- **#452** warm set — after #446 and #442
- **#454** re-auth — after #450

### Cross-lane gates

- #441 (A) waits on #440 (C)
- #448 (A) waits on #441 (A) and #442 (B)
- #450 (A) waits on #441, #448, #449
- #443 (B) waits on #442 (B)
- #452 (C) waits on #446 (C) and #442 (B)
- #454 (C) waits on #450 (A)

**Critical path:** #440 → #441 → #448 → #450 → #454. Start #440 and #455 immediately;
everything else queues behind one of them.

## Model assignment

Grounded in measured coding index and agentic benchmarks, not general intelligence rank.

### Astra — `gpt-6-astra`, **high effort, never max**

Intelligence 52.7 (highest available here), coding 77.1 at high. Use it for novel design
where the answer is not in the story.

- **#443** hang detection — the probe design is genuinely new work
- **#448** ladder execution — the hardest recovery semantics in the epic
- **#452** warm set — eviction, budgets, bounded concurrency

**Use high, not max.** Max scores *lower* on coding (76.9 vs 77.1) and carries a
202,780 ms time-to-first-token — three and a half minutes before a byte. High is
23,158 ms. Max is strictly worse on both axes here.

### Opus 5 — breadth-critical, multi-file architecture

1M context is the differentiator, coding 78.0. Use where the work requires holding
`orchestrator.ts` plus the mux plus the router simultaneously — which is exactly where
the contradictions between layers live, and why four separate derivations of
`promptInFlight` went unnoticed for months.

- **#441** resolver extraction from a 24k-line file
- **#442** health reporting — spans four files and retires four derivations
- **#444** output log and cursor protocol
- **#447** inbound queue
- **#450** tiered presentation — wide integration surface

### Sol — `gpt-5.6-sol`, xhigh — agentic and iterative

Coding 78.3, and the **only** model in this pool with measured agentic benchmarks:
`tau2` 0.848, `terminalbench_hard` 0.659, `ifbench` 0.73. Its intelligence index of 44
badly undersells it for tool-heavy work. $8 blended.

- **#440** adapter normalization — eight profiles, heavily iterative, test-driven
- **#455** metadata ingestion — debugging a pipeline
- **#449** fallback chain
- **#445** snapshot and the `messages.edit` optimization
- **#454** re-auth via elicitations

### Grok 4.6 — small, well-scoped, cheap

Coding 76.8 at $3 blended, 500k context. Plenty for single-file work.

- **#446** durable binding
- **#451** recovery context
- **#453** copilot collapse

## Dispatch protocol

**One story per worker. Never steer a worker mid-flight.** Today's duplicate PR pair came
from exactly that: new information arrived, the worker was told to re-scope, and it had
already built the thing. If new information lands, let the current story finish and put
the change in the next brief.

**Brief with symbols, not line numbers.** Two references in these stories drifted the
same day they were written, because merges shifted them. Say `isRateLimitError` and
`the runtimeBusy short-circuit in inspectChannelQueue`, not `:3858` and `:2111`.

**Build in a worktree.** Parallel agents share one checkout; another's reset drops your
commit. Push and verify quickly.

**Never `--delete-branch` a PR that is the base of a stacked PR.** It auto-closes the
dependent and the base cannot be restored to reopen it. That cost a detour today.

## Gates before merge

- Full suite, not a targeted subset, whenever `ops/bridge/targets.json`, the fleet tests,
  or anything under `docs/` guarded by the allowlist is touched. Skipping this broke main
  once already.
- For anything touching the bridge or the transport: **verify on a real host**. Loopback
  fixtures cannot falsify an assumption they were built from. #427/#435 passed on loopback
  with an untested assumption that could have terminated the entire fleet; only a live
  test through the real tunnel retired it.
- State what was not checked. "I could not verify X" is a finding; silence about X is a
  defect.

## Deploy order once stories land

Ship Lane B before Lane A where possible. Transport correctness makes Lane A's failures
legible — until a dead socket settles its callers, an orchestrator-level failure is
indistinguishable from a transport one, and you will debug the wrong layer.
