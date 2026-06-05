# Durable background jobs + resume — build plan

**Status:** draft / proposal
**Purpose:** let an agent kick off long-running work, end its turn (freeing the
user to keep chatting), and be **automatically resumed** when the work finishes —
durably, and across **all** agent profiles (Claude, Copilot, agy), not just the
ones with a native background mechanism.

---

## 1. Problem & evidence

seam-acp models each Discord message as exactly one ACP `session/prompt`, awaited
once and finished at `end_turn` (`agent-runtime.ts:367` `prompt()`). The Claude
Code harness features an agent naturally reaches for — `run_in_background` bash,
`Monitor`, `ScheduleWakeup` — all assume the **harness re-invokes the model after
the turn ends** when an event fires. That re-entry has no carrier here, and the
work is fragile besides. Verified facts:

- **Turn duration is NOT the limiter.** `TURN_TIMEOUT_SECONDS=129600` (36h) in
  `.env`, and `raceWithTimeout` (`orchestrator.ts:4607`) doesn't even cancel the
  underlying turn — it only stops awaiting. Long *synchronous* work already runs
  fine (a multi-minute compaction finished in-turn).
- **The adapter emits nothing after `end_turn`.** Probe (`/tmp/acp-bg-probe.mjs`):
  when the model launched a bg task and tried to end, claude-agent-acp **held the
  `session/prompt` open**, re-invoked the model on completion *in-turn*, then
  ended. Post-`end_turn` `session/update`s: **0**. So "listen after the turn"
  catches nothing — the only in-band delivery holds the turn hostage.
- **A held-open turn is reaped on interruption.** `cancel()` does
  `process.kill(-child.pid, …)` (`agent-runtime.ts:483`) — a **process-group**
  kill. Any new message / retry / `invalidate` while the turn is open reaps every
  process the agent spawned. This is what silently killed the earlier background
  runs during active back-and-forth.

**Conclusion:** the fix must (a) run work **outside the agent's process group** so
it survives turn-end and interruption, and (b) re-enter the conversation from the
**bridge layer**, since the agent cannot prompt itself and ACP carries no
post-turn channel.

---

## 2. Design principles

1. **Bridge-owned, not agent-owned.** The capability lives in seam-acp, reached
   through the normal `orchestrator → runtime.prompt()` path, so every profile
   gets it for free. Do not depend on any Claude-Code-specific harness feature.
2. **Detached execution.** Jobs run under their own session (`setsid`/double-fork)
   so the process-group kill can't reap them.
3. **Checkpoint to disk.** Job progress/result is a file, so resume needs no live
   state (this is exactly the pattern that rescued the compaction run:
   stage-by-stage `.raw.jsonl` + a resume script).
4. **Carry intent across the gap.** The agent authors a `resume_prompt` at submit
   time — instructions to its future self — so the resumed turn knows what to do
   without the lost context.
5. **Universal first, rich where possible.** Build the lowest-common-denominator
   path (works for agy too), then layer richer ergonomics for agents that support
   them.

---

## 3. Job lifecycle

```
agent submits job ─┐
                   ▼
         [1] job spec lands (MCP tool call OR job-spec file)
                   ▼
   end of turn ──► [2] orchestrator drain-hook picks up pending specs
                   ▼
         [3] launcher spawns the job DETACHED (setsid), records it "running",
             returns control; agent's turn ends; user keeps chatting
                   ▼
         job runs, checkpoints to <job>/status.json + writes output
                   ▼
         [4] completion watcher sees status=done|failed
                   ▼
         [5] resume injector starts a fresh turn in the originating thread:
             prompt = resume_prompt + status + output path
                   ▼
         agent reads the output, reports to the user (normal turn → Discord)
```

---

## 4. Components & seams

### 4.1 Job spec + store
- On-disk under `DATA_DIR/jobs/{pending,running,done}/<jobId>.json`. Mirrors the
  existing sentinel convention (`data/.restart-pending`).
- Schema:
  ```jsonc
  {
    "jobId": "…",
    "thread": "<discord channel/thread id>",     // where to resume
    "sessionId": "<seam session id>",
    "agentId": "claude|copilot|agy|…",
    "command": "node /path/run.mjs …",           // what to run
    "cwd": "/repo/path",
    "host": "local" | "<remote profile id>",     // where to run it
    "label": "compaction-bdf3a481",
    "resumePrompt": "Job done — read <out>, verify …, report to the user.",
    "createdUtc": "…",
    "status": "pending|running|done|failed",
    "outputPath": "…",          // filled by the job/launcher
    "exitCode": null
  }
  ```
- Store helper module: `src/core/jobs/store.ts` (create / claim / transition).

### 4.2 Detached launcher — `src/core/jobs/launcher.ts`
- **Local host:** `spawn(cmd, { detached: true, stdio: ['ignore', fd, fd] })`
  followed by `child.unref()`, launched via `setsid` (new session/process group)
  so `cancel()`'s `process.kill(-pid)` cannot reach it. Redirect stdout/stderr to
  `<job>/log`. Write `status.json` transitions.
- **Remote host (Mac):** add a `runJob` / `pollJob` action to the bridge command
  channel — same pattern as `writeAttachment` (`remote-agent-bridge.mjs`
  `handleCmd`, and `remote.ts` `buildSessionManager` `sendCmd`). The Mac bridge
  spawns the job detached on its side and reports completion back over the
  existing WebSocket.

### 4.3 Drain-hook integration — `orchestrator.ts`
- After a turn drains (the same place the restart sentinel is handled), scan
  `jobs/pending/`, launch each, move to `jobs/running/`. Keeps job launch off the
  turn's critical path and out of its process group.

### 4.4 Completion watcher + resume injector
- A small watcher (fs.watch on `jobs/running/`, or a poll) detects
  `status ∈ {done,failed}`.
- **Resume injection** = the one genuinely new orchestrator entry point: start a
  turn programmatically (no Discord message). Look up the session for `thread`,
  build the prompt `resumePrompt + "\n\n[job <label>] status=<…> output=<path>"`,
  and run it through the existing prompt → fence/flush → Discord pipeline.
  - **Serialization:** if a turn is already active on that thread, queue the
    resume until it ends (reuse the per-session serialization the router already
    enforces; `session-router.ts` `abortTurn`/runtime cache).
  - Post a small Discord notice ("▶️ resuming: <label> finished") so the user
    sees why the bot spoke unprompted.

### 4.5 Invocation surfaces (how the agent submits)
- **MCP tool `submit_job`** — for Claude & Copilot.
  - Add to `buildGlobalMcpServers` (`src/mcp.ts`); a tiny stdio MCP server seam-acp
    owns. Claude gets it via forwarded `_meta` mcpServers; Copilot via
    `--additional-mcp-config` (already wired in `copilot.ts`).
  - The server **declares instructions** in its `initialize` handshake (this is
    how the Figma server surfaces its preamble) — see §5.
  - Tool writes the job spec to `jobs/pending/` and returns `{ jobId }`.
- **File/sentinel job-spec** — universal, **required for agy** (no MCP).
  - The agent writes `jobs/pending/<id>.json` directly with its file tools, or
    runs a one-line `seam-job submit -- <cmd>` helper on PATH.
  - This is the lowest common denominator; everything else is sugar over it.

### 4.6 Discoverability layer (how the agent *knows* to use it)
The failure mode was reaching for the wrong (native) tool with no signal. Fixes,
by channel (see the matrix in §6):
- **Repo instruction files** (persistent, free, every agent reads its own):
  document the rule + `submit_job` usage in `CLAUDE.md`, `AGENTS.md`, and agy's
  instruction file. Prefer consolidating on `AGENTS.md` where the agents share it.
  *This is the foundation — present at turn 1 and turn 50, no per-turn cost.*
- **Claude only — `_meta.systemPrompt:{append}`:** append the house rules to the
  `claude_code` preset (verified: `claude-agent-acp` acp-agent.js:1480 forwards
  `append`). Wire in `claude.ts` `newSessionMeta()` alongside the existing
  `_meta.claudeCode.options`.
- **Claude only — remove the footgun:** restrict the tool list via
  `_meta.claudeCode.options.tools` (acp-agent.js:1513) so `run_in_background` /
  `Monitor` / wakeups aren't even offered. (Copilot/agy never had them — nothing
  to remove there.)
- **MCP tool `instructions`:** ship the "use me for long work; you'll be
  auto-resumed" guidance with the tool itself (Claude + Copilot).
- **Prompt-text banner** (`orchestrator.ts:771` precedent): keep in reserve for
  situational nudges; no longer load-bearing once the repo files exist.

---

## 5. MCP `submit_job` server sketch

- Stdio MCP server (`src/mcp/job-server.ts` or a standalone script registered in
  `mcp.ts`).
- `initialize` → returns `instructions`:
  > "This environment runs agents turn-by-turn; native background tasks/monitors
  > do not persist. For any long-running or deferred work, call `submit_job`. You
  > will end your turn and be automatically resumed in this thread when the job
  > completes. Provide a `resume_prompt` telling your future self what to do with
  > the result."
- Tool `submit_job({ command, cwd?, label?, resume_prompt, host? }) -> { jobId }`.
- Tool `job_status({ jobId }) -> { status, outputPath?, exitCode? }` (optional).

---

## 6. Cross-agent capability matrix (verified)

| Channel | Claude | Copilot CLI | agy |
|---|---|---|---|
| Repo instruction file | ✅ `CLAUDE.md` | ✅ `AGENTS.md` / `.github/copilot-instructions.md` | ✅ (reads its own) |
| Prompt-text injection | ✅ | ✅ | ✅ (`agy -p "<promptText>"`) |
| MCP tool + instructions | ✅ (`_meta` mcpServers) | ✅ (`--additional-mcp-config`) | ❌ no MCP |
| System-prompt append (ACP) | ✅ `_meta.systemPrompt:{append}` | ❌ | ❌ |
| Tool-list surgery | ✅ `_meta…options.tools` | ❌ (own tools) | ❌ (own tools) |
| **Job invocation** | MCP **or** file-spec | MCP **or** file-spec | **file-spec only** |

The footgun (`run_in_background`/Monitor/wakeups) is **Claude-only** — Copilot and
agy have no such tools, so for them the work is purely "advertise `submit_job`."

---

## 7. Phased implementation

**Phase 0 — instructions (no code path; immediate, universal).**
Write the house rules + the manual job-spec convention into `CLAUDE.md` /
`AGENTS.md` / agy's file. Even before the runner exists, this stops agents from
reaching for the doomed native features.

**Phase 1 — universal core (file-spec + local launcher + resume).**
Job store (§4.1) → drain-hook launch (§4.3) → detached local launcher (§4.2) →
completion watcher + resume injector (§4.4). Submission via file-spec only. This
alone makes durable jobs+resume work for **all** agents.

**Phase 2 — MCP ergonomics.**
`submit_job` MCP server (§5) wired into `mcp.ts`; instructions in the handshake.
Nicer for Claude/Copilot; agy still uses the file-spec.

**Phase 3 — Claude hardening.**
`_meta.systemPrompt:{append}` + tool-list surgery in `claude.ts` `newSessionMeta`.

**Phase 4 — remote-host jobs.**
`runJob`/`pollJob` over the bridge command channel for jobs that must run on the
Mac (e.g. the RHEL/`az` work). Same pattern as the `writeAttachment` handler.

---

## 8. Testing / verification

- **Reaping immunity:** submit a job, then immediately send 3 messages + a
  `cancel`; confirm the detached job keeps running (it must NOT be in the agent's
  process group). Inspect with `ps -o pgid`.
- **Resume correctness:** a job that writes a known file; confirm the bridge
  starts a fresh turn carrying `resume_prompt` + path, and the agent reads it.
- **Serialization:** complete a job *while a turn is active* on the thread;
  confirm the resume queues and fires after, not concurrently.
- **Cross-agent:** run the file-spec path on agy (no MCP) and the MCP path on
  Claude/Copilot; both reach the same store and resume.
- **Discoverability regression:** start a fresh session and ask for long work;
  confirm the agent reaches for `submit_job`, not `run_in_background`.

---

## 9. Open questions / risks

- **Resume into a compacted/expired session.** If the session was compacted or
  the runtime evicted between submit and completion, the resume turn may lack
  context — `resume_prompt` must be self-contained (treat it like a fresh brief).
- **Output size.** Large job outputs should be referenced by path, not inlined
  into the resume prompt (mirror the compaction approach: write to disk, point at
  it).
- **Multiple jobs / same thread.** Decide ordering and whether to batch resumes.
- **`AGENTS.md` consolidation.** Confirm which agents read `AGENTS.md` vs. their
  own file so the rules live in as few places as possible.
- **Remote detachment semantics.** Verify `setsid` on macOS for the bridge path;
  confirm the bridge's own restart doesn't orphan/kill running jobs.

---

## 10. Out of scope (for now)

- Making the *native* Claude background/Monitor/wakeup features work over ACP
  (Tier 3) — the probe shows nothing is emitted after `end_turn`, so it's not
  reachable without adapter changes; not worth it given Phase 1 covers the need.
- Cron-style recurring schedules — the same machinery could back it later, but
  start with one-shot jobs.
