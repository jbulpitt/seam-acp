# seam-MCP — orchestration runtime north-star

**Status:** vision / seed (not greenlit) · **Created:** 2026-07-01 · **Owner:** jbulpitt

**One-line:** seam-acp bridges Discord ↔ agents; **seam-MCP** is the layer on top
that turns Discord threads into an **observable, steerable, heterogeneous
multi-agent orchestration fabric** — where every "sub-agent" is a real thread you
can watch and interject in, backed by whatever agent/model you choose.

This doc names the core primitive, draws the seam-acp ↔ seam-MCP boundary (the
one decision that actually matters), maps the existing design docs onto it, and
records the load-bearing decisions with a recommendation each. It supersedes
nothing yet — it's the frame the other docs plug into.

---

## 1. Thesis — why this is worth a distinct layer

The existing sketches already reach for multi-agent orchestration, but through a
**convention** (`seam-delegate:` fences) whose own author flags its fatal weakness
([agent-delegation-framework §2.4](./agent-delegation-framework.md)): the return
path is a *behavioral hope* — the target agent has to **remember** to emit a
report-back fence. A text fence has no return channel.

**An MCP tool call does.** The leap seam-MCP makes is not "structured tools are
nicer" — it's that **report-back stops being a hope and becomes a runtime
guarantee.** When Thread A hands work to Thread B, seam-MCP (the runtime) holds
the correlation: it knows B's turn produced output X and delivers it back to A —
or forwards it to C — *without B having to remember anything.* That is the
difference between orchestration-by-convention and orchestration-as-a-runtime.

Everything else in this doc follows from making that guarantee real.

**The differentiator (the moat).** Claude's own sub-agent framework is
single-process, single-model, opaque, and ephemeral. seam-MCP's "sub-agents" are
Discord threads:

- **Heterogeneous** — any agent/model per node (Claude, Sonnet, Gemini/agy,
  Codex, Grok, Copilot).
- **Observable** — every worker is a thread you read live; no black box.
- **Steerable** — you can post into any node mid-run (validated: a message during
  a `Monitoring` node is absorbed without losing the node's task).
- **Persistent** — threads carry durable sessions/history.

Claude's is a black box tuned for one model; seam-MCP is a **glass-box fabric
across models where every worker is a thread you can watch and steer.** That
transparency + heterogeneity + human-in-the-loop-by-construction is exactly what
the closed CLI frameworks cannot offer.

---

## 2. The core primitive — the thread as an actor

A Discord **thread** is an *addressable, agent-backed actor*. seam-MCP's entire
surface is actor operations over threads:

- **`spawn` / target** — a thread bound to a chosen agent+model (via presets).
- **`send`** — deliver a prompt to a thread (starts a turn there).
- **`await` / report** — receive a thread's turn output (sync or via callback).
- **`forward` / pipe** — route one thread's output into another as its next input.
- **`peek` / query** — read a thread's recent state without prompting it.
- **`steer`** — inject guidance into a *running* node (preemptive cancel-and-
  resteer, or ride the natural yield windows — see [hitl-steering-plan](./hitl-steering-plan.md)).

**Everything above reduces to ONE mechanism:** a **programmatic turn** —

> run a turn *for* thread `T` with payload `P`, in mode `M`, routing output to `O`.

The features already sketched are all this primitive with different parameters:

| feature | thread | payload | session mode | output route |
|---|---|---|---|---|
| scheduled prompt (built) | its own | the cron prompt | **isolated** (throwaway) | cards → origin/`targetChannel` |
| durable-job resume (proposed) | originating | `resume_prompt` + result path | **live** session | normal turn → its thread |
| delegation delivery (WIP) | target | the delegated prompt | **live** target session | target's thread |
| report-back / forward | caller or next | prior node's output | either | caller's thread or next node |
| peek (WIP) | current | fetched messages of another thread | **live** (context inject) | current thread |

The two **session modes** are a real design axis, and the existing docs already
split on it: scheduled prompts run **isolated** throwaway sessions (no pollution
of the live conversation), while durable-jobs **resume the live session**. seam-MCP
needs both as modes of the same `injectTurn`.

---

## 3. The layering & the boundary contract (the decision that matters)

```
        agents (Claude / Codex / Copilot / agy …)
              │  call MCP tools   │  emit fence-directives (universal fallback)
              ▼                   ▼
        ┌─────────────────────────────────────────────┐
        │  seam-MCP  — orchestration RUNTIME           │
        │  • MCP tool server(s) + fence-directive input│
        │  • thread registry / aliases                 │
        │  • correlation & callbacks (report-back)     │
        │  • delegation ledger + watchdog (loops/cost) │
        │  • workflow graph / observability            │
        └───────────────▲─────────────────────────────┘
                        │  narrow internal contract  (§3.1)
        ┌───────────────┴─────────────────────────────┐
        │  seam-acp  — the BRIDGE / substrate          │
        │  Discord ↔ agent, sessions, status cards,    │
        │  ACP runtimes, output pipeline, thread life  │
        └──────────────────────────────────────────────┘
```

- **seam-acp stays boring and unbreakable.** It is the pipe people rely on. It
  gains *no orchestration intelligence* — it only exposes the seams seam-MCP needs.
- **seam-MCP is where the ambitious/experimental orchestration lives** and iterates
  independently, so a bug there never takes down the bridge.
- **seam-MCP is a *runtime*, not "some MCP tools."** MCP is one delivery surface;
  the substance is correlation, callbacks, safety, and the workflow graph.

### 3.1 The internal contract seam-acp must expose

This is the real deliverable. Get it narrow and explicit and the repo topology
(§8) becomes a cheap, late, reversible decision. Draft surface:

```ts
interface BridgeControl {
  // addressing / registry
  resolveThread(ref: ChannelRef | Alias): ThreadHandle | undefined;
  listThreads(): ThreadHandle[];                 // + alias CRUD

  // THE primitive — a programmatic turn (no Discord message)
  injectTurn(t: ThreadHandle, prompt: string, opts: {
    session: "live" | "isolated";                // §2 modes
    model?: string; effort?: string; cwd?: string;
    attachments?: Attachment[];
    outputTo?: ThreadHandle;                      // default: t
    correlationId?: string;                       // for report-back
  }): Promise<TurnHandle>;

  // completion / report-back correlation
  onTurnComplete(cb: (r: { correlationId?: string;
    thread: ThreadHandle; output: string; files: FileRef[];
    stopReason: string }) => void): Unsubscribe;

  // read without prompting
  readThread(t: ThreadHandle, count: number): Promise<Message[]>;

  // introspection
  sessionInfo(t: ThreadHandle): { agentId: string; model?: string; repo?: string };
}
```

Everything seam-MCP does composes from `injectTurn` + `onTurnComplete` +
`resolveThread` + `readThread`. Note `injectTurn` **must** use the internal
handler path (the scheduled-prompt / compaction-runner pattern), **not** a bot
Discord message — [cross-thread-build-spec §4](./cross-thread-build-spec.md) flags
that bot messages are filtered by `onMessage`, so delivery-by-posting silently
no-ops.

---

## 4. What folds in — mapping the existing docs

| doc | status today | role in seam-MCP |
|---|---|---|
| [agent-delegation-framework](./agent-delegation-framework.md) | vision + WIP branch | the spine: `send`/target, aliases, ledger, watchdog — upgraded from fire-and-forget fences to a return-channel guarantee |
| [cross-thread-build-spec](./cross-thread-build-spec.md) | WIP `feat/delegation-presets` | concrete `send` (`emitDelegateFence`), `peek`, alias CRUD, presets — the first draft of the actor ops |
| [durable-jobs-plan](./durable-jobs-plan.md) | proposal | the **report-back-over-time substrate**: detached execution + the *resume injector* (programmatic **live**-session turn). This IS async report-back. |
| [hitl-steering-plan](./hitl-steering-plan.md) | proposed | `steer`. Per the loop-yield realization, its cooperative `check_in` tier is largely **superseded** by natural node yields; keep the preemptive tier. |
| [scheduled-prompts-plan](./scheduled-prompts-plan.md) | **built (v1)** | the trigger source, and the reference impl of the **isolated** `injectTurn` mode (throwaway session → cards). **Splits** (§6.3). |

### 4.1 The scheduler split (resolves the "deciding factors")

Scheduling is two things wearing one name:

- **The durable timer/daemon** that fires when *no agent is alive* → stays in
  **seam-acp** (it already exists: `ScheduledPromptManager`, cron-rehydrated on
  boot). This is substrate.
- **The agent-callable "schedule a future run / recurring workflow"** → a
  **seam-MCP tool**. An agent scheduling work is an orchestration act.

Same engine underneath; two faces. That's the clean resolution.

### 4.2 A landscape note that dates two of these docs

`durable-jobs-plan.md §1` concluded (measured on **claude-agent-acp 0.39**) that
**nothing emits after `end_turn`** and native background/Monitor is unreachable
over ACP. The **0.54.1 upgrade partly overturned that** — Monitor-woken turns now
*do* emit post-`end_turn` (that's why seam-acp gained the `Monitoring`/woken-turn
display). **But the durable-jobs conclusion still stands for seam-MCP:** the native
mechanism is **Claude-only**, its processes are **children of the agent process**
(reaped on the ~hourly recycle / any restart), and it re-runs stale notifications
on resume. So **do not build orchestration on the native Monitor.** Build the
bridge-owned, detached, checkpointed, resume-injected substrate durable-jobs
describes — it's universal, durable, and quiet. Native Monitor is a fragile
convenience, not infrastructure.

---

## 5. The three load-bearing decisions

**5.1 Report-back: async-callback (recommended) vs sync-await.**
Sync (the caller's tool call blocks until the target produces output) composes
beautifully but ties up the caller's turn and hits the agent/SDK **tool timeout**
on long work (the HITL blocking-poll trap). Async returns a handle immediately and
delivers later — but "later" means **re-waking the caller**, which is exactly the
Monitor/task-notification pattern (stale-wakeup caveat and all — everything we
debugged on 2026-07-01 lands right here).
→ **Recommendation:** async-by-default with a correlation id + `onTurnComplete`
delivery (the durable-jobs resume injector). Offer a **bounded** await for quick
calls. This is the single highest-leverage decision and the one most entangled
with the wake mechanics.

**5.2 Interface: layer MCP *and* fence — don't choose.**
Per [durable-jobs §6](./durable-jobs-plan.md), MCP tools reach Claude + Codex +
Copilot but **not agy** (no MCP). The fence-directive / file-spec / prompt-inject
path is universal.
→ **Recommendation:** seam-MCP is the runtime; **MCP tools are the rich interface**
(typed args + return values → the report-back guarantee), and the **fence-directive
survives as a universal compat input** into the *same* runtime for non-MCP agents.
The runtime owns correlation regardless of input channel.

**5.3 Addressing + the per-session routing token (foundational).**
MCP tool calls don't carry the ACP session id ([hitl-steering §6](./hitl-steering-plan.md)),
so a shared MCP server can't tell *which* thread is calling.
→ **Recommendation:** mint a token when a runtime starts, map `token → record.id`,
inject a per-session HITL/seam-MCP `McpServer` entry carrying it, revoke on
dispose. Tool calls then arrive knowing the **caller**; they resolve **targets**
via the alias registry. Everything rides on this plumbing — build it first.

---

## 6. Safety & observability (orthogonal, from day one)

Cross-model fan-out can explode cost and loop. Keep safety **out of the hot path**
(the [delegation §4 watchdog](./agent-delegation-framework.md) stance):

- **Delegation ledger** — every programmatic turn logged (source, target, prompt
  preview, correlation, status). Audit trail + watchdog input.
- **Watchdog** — loop detection (SCCs in the source→target graph), frequency caps,
  per-workflow **token/cost budgets** (tie to the turn budget concept), quiet-target
  timeouts. Alert + park, never silently wedge.
- **Workflow graph view** — `/seam workflows`: which threads wait on which. Without
  this a cross-thread workflow is spooky action at a distance.
- **Trust / data boundary** — routing across accounts/models crosses trust and data
  egress lines (cf. the ZDR-keyed work). Policy for *who may target what* and *what
  data may cross* is a real surface, not an afterthought.

---

## 7. Incremental path (reuse what exists)

1. **Extract the primitive.** Refactor scheduled-prompts' isolated runner + the
   compaction runner + (proposed) durable-jobs resume injector behind one
   `injectTurn(session, outputTo, correlationId)` in seam-acp. This is the contract
   (§3.1) — the highest-value, lowest-risk first move.
2. **Report-back correlation.** `correlationId` + `onTurnComplete`; land the
   durable-jobs detached launcher + resume injector as its first consumer.
3. **seam-MCP runtime skeleton** — per-session token wiring (§5.3), the registry
   (lift alias CRUD from the WIP branch), the MCP `send`/`await`/`peek`/`forward`
   tools; fence-directive as the compat input adapter.
4. **Ledger + watchdog + `/seam workflows`.**
5. **Scheduler-as-tool** and workflow templates (§4.1).

Each step is shippable and independently useful. The delegation WIP branch
(`feat/delegation-presets`) and the built scheduler are ~40% of step 1–3 already.

---

## 8. Repo structure — guidance

**Recommendation: start as a separate package + separate process inside this repo
(monorepo); keep extraction to its own repo open.** Rationale:

- The seam-bridge plan already leans monorepo; shared types (`ThreadHandle`,
  `SessionRecord`, the §3.1 contract) churn heavily early — a monorepo shares them
  free; a separate repo taxes every change with publish-and-bump.
- Independent *deploy* ≠ independent *repo*: seam-MCP is its own build target + pm2
  process in the monorepo (blast-radius isolation without split overhead).
- **The boundary contract (§3.1), not the repo, is what matters.** Keep it narrow
  and enforced and a later repo split is a *move, not a rewrite*.

**Split to its own repo only when a real trigger appears:** you want seam-MCP to be
**bridge-agnostic** (run against a non-Discord front end — the strongest signal);
the contract stabilizes so publishing a shared package is cheap; or external
consumers / separate release cadence emerge. None are true today.

---

## 9. Open questions

- **Isolated vs live default** for `injectTurn` per op — delegation to a *worker*
  wants live (its own ongoing session); a one-shot report wants isolated.
- **Output shape across a pipe** — raw text, a structured summary, or an artifact
  reference (mirror the compaction "write to disk, pass the path" rule for large
  outputs).
- **Backpressure / concurrency caps** per workflow and globally (the concurrency
  cap idea from the workflow tooling applies here).
- **Identity of a programmatic turn in the transcript** — how the receiving thread
  labels "this turn came from thread X / job Y" (cf. `<seam-context>` in peek).
- **How much the native 0.54.1 Monitor should be *suppressed*** (tool-list surgery,
  durable-jobs §4.6) to steer agents onto the durable substrate instead.
