# Session authority: what this work is, and how to not get it wrong

Read this before touching anything under epic #439. It is short on purpose.

This complements the defaults in `AGENTS.md` (*How we build here*) and the
review guide (`docs/agent-guides/review-guide.md`). Both apply here in full.

## The thesis, in one paragraph

Every reliability failure in this series has the same shape: **the facts live on one
machine and the decisions are made on another, connected by the exact link that fails.**
The bridge holds the child process, sees its output, watches it die. seam-acp decides
whether a turn is alive, when it times out, whether a queue is wedged, whether to resume.
Between them is a WebSocket, and when it breaks seam-acp keeps deciding from evidence
that stopped arriving. That is why five layers reach five contradictory conclusions about
the same thread. The work is to move authority to where the evidence already is.

## Eight ways this codebase got it wrong

These are not hypotheticals. Every one is from this repository, and several are mistakes
made while diagnosing the others.

### 1. Refusing to act is not the conservative choice

The instinct to stop when uncertain feels safe and usually isn't. A model substitution
announced to the user is blast radius 2 — works with a caveat. A failed turn is a dead
thread needing manual recovery, which is 3 or 4. *Stopping is the worse outcome* and it
is the failure this whole epic exists to fix.

This was argued twice during design — first against automatic model fallback, then for a
"preserve and report, don't guess" default on unknown errors — and both were wrong for
the same reason: weighing the risk of acting without weighing the cost of not acting.

**Always continue. Always surface. Every path ends still trying, never silent.** A
process or connection that went away is reconnected, respawned, or waited for; it is
not a reason to stop the turn (#631).

### 2. Do not name a bug as a state and then build machinery to manage it

`ChannelQueueState` is `idle | runtime_busy | queued | wedged | stalled`. Three of those
describe a system working. Two describe a system that failed in a way nobody diagnosed —
and they sit in the same enum as peers, as though "broken in an unknown way" were a
legitimate operating mode.

Once named, they got a tunable grace period, an admin recovery command, and an automatic
sweep. **The bug became survivable, and survivable bugs do not get fixed.** #425 shipped
a sweep for wedged channels; it worked exactly as designed and did not fix the three
threads it was written for, because the cause was a layer below where "wedged" is even
computed.

Triage vocabulary is fine. Turning it into architecture is not.

### 3. When a fact is available, do not infer it

- `errorKind` is checked in two places and **produced nowhere**. The only structured
  check in the error path is dead code; classification is regex-on-English 100% of the time.
- The "Monitoring" card state matched a **tool title** against `/^monitor/i` rather than
  asking whether a wake was pending — a fact sitting in `wake_events`.
- Turn health is four independent derivations of one boolean, `promptInFlight`, which
  goes stale the moment the transport hiccups.

In every case the authoritative fact existed and was not asked for.

### 4. One owner per failure class

#421, #424 and #429 each grew their own retry. Three bounded retries compose into an
unbounded one, and the result is a system whose behaviour nobody can predict. One owner
attempts bounded recovery; every layer above **reports** the outcome rather than
re-attempting it.

### 5. Do not guard against a hazard that does not exist here

`!textSent && !textBuffer` refuses to retry any turn that emitted a character, on the
theory that re-running could duplicate side effects. But ACP sessions are not stateless:
the transcript contains the tool call *and its result*, so the model continues rather
than repeating. The guard prevents something that cannot happen, and costs real recoveries.

Check whether the hazard applies to *this* system before defending against it.

### 6. Absence of evidence in a log you have not verified is not evidence of absence

Both of these happened in one morning:

- Grepped for `queue sweep` lines, found zero, nearly reported the sweep as dead. It had
  fired 30 seconds *after* the grep ran.
- Grepped for liveness terminations, found zero, nearly reported a clean bill of health.
  `onLivenessTimeout` is declared and wired to nothing, so no such line can ever exist.

Before concluding "it didn't happen," confirm the thing you searched for is something
that *could* have been written.

### 7. Verify with the right instrument

Grepping `dist/index.js` for orchestrator code that compiles to a different dist module.
Running `systemctl is-active` against a PM2-managed host. Reading `/proc/<pid>/environ`
for values loaded at runtime by dotenv. Each produced a confident wrong answer.

When two instruments disagree, find out why before picking one.

### 8. Report what happened, not what you intended

The sweep logs `recovered a wedged channel automatically` for threads that are still
dead. A false success record is worse than the silence it replaced — it moves the outcome
toward blast radius 5.

## Design invariants for this epic

**The daemon stays ignorant.** No Discord knowledge. No provider error *semantics*. No
model catalog reasoning. No retry *policy*. These change weekly, and the daemon runs on
hosts that are hard to update — four of eight currently cannot be updated through the
rollout tooling at all.

**Stable function, variable data.** This shape recurs and it is the answer nearly every
time the question is "where does this belong." The resolver is frozen code; its rules are
a table. The ladder is frozen code; the directive arrives with the work. The fallback
chain is computed upstream and shipped as a list. A new provider wording is a row. A new
agent is an adapter. Neither is a daemon deploy.

**One owner per fact, and the owner is whoever observes it directly.** The daemon is
authoritative for session and turn state. It is not authoritative for delivery proof
(that is between seam-acp and Discord) or thread config (the presets file).

**Determinism where recovery depends on it.** Tier 2 options are computed, not generated.
An LLM-generated recovery path asks a broken agent how to recover from being broken. It
also cannot be unit-tested, and users never build muscle memory for a card that is novel
every time.

**Prefer measured numbers to assumed ones.** The sizing in these stories is measured:
~593 MB per live Claude session, 13 GB of Codex transcripts, 2,200 transport disconnects
against 1,040 agent exits. If you need a number, go get it. The database and the journal
are both right there.

## Before you call something done

Run it on the real host. Fixtures cannot falsify an assumption they were built from — of
the last four bugs found in the agy verifier, four were found on hosts and zero by the
suite. The liveness work in #427/#435 passed on loopback sockets and still had an
untested assumption that could have terminated the entire fleet; it took a live test
through the real tunnel to retire that risk.

State what you did not check. "I could not verify X" is a finding. Silence about X is a
defect.
