# Premium Compaction — Design & Build Spec

A high-fidelity, multi-agent compaction routine offered as an **explicit premium
option** (a button on `/seam sessions`), alongside the existing cheap single-pass
compaction. The framing: some sessions are vital enough that the expense of an
exhaustive, multi-agent analysis is worth it. This doc is the buildable spec —
architecture, rules, the full prompt suite with I/O contracts, and the
verification plan.

> Status: design locked, not yet built. Authored from the design discussion of
> 2026-06-01. Build + empirical tuning still required (see §10).

---

## 1. The two tiers

| | Default tier | Premium tier |
|---|---|---|
| Trigger | manual `/compact`, or an agent's own auto-compaction | a new **button** on `/seam sessions` (manual, deliberate) |
| Method | single-pass summary | multi-agent fan-out → reduce → deep-dive → synthesize → critic |
| Cost | cheap | expensive (the point) |
| Goal | "good enough to continue" | "lose nothing load-bearing" |

**Both tiers** share three improvements over today's compaction (these are the
cheap, high-leverage wins and they belong in the default tier too):
1. **Verbatim recent window** — keep the last K turns word-for-word; summarize
   only the older prefix.
2. **Verbatim pinned-facts block** — exact corrections/constraints/decisions/
   open-TODOs/active file paths, carried verbatim, never summarized.
3. **Visible drop-note** — a short "what was compressed / what to re-inject if
   needed" message so loss is *visible and recoverable*, never silent.

---

## 2. Locked decisions (from the design discussion)

1. **We do NOT disable any agent's own auto-compaction.** It fires if it fires
   (user watches). Premium is a separate, manual, button-triggered operation.
   Consequence: if an agent already auto-compacted, the session's early history
   is itself a summary — which the gap-detector (§5) catches and routes around.
2. **Works for all agents** — orchestration is agent-agnostic (operates through
   `ISessionManager` + the Discord adapter). **Extraction fidelity is bounded by
   each agent's stored richness** (graceful degradation): Claude can offer
   thinking + tool context; agy/Copilot offer whatever their stores persisted.
   You can only preserve what was written to disk.
3. **The analysis never runs in the live session.** It spawns separate temp
   agents that read chunks **from disk**, so the live session being near-full is
   irrelevant — no chicken-and-egg.
4. **Deep-dive is comprehensive, never gated.** Reading everything thoroughly is
   the entire reason to choose premium over the cheap path. The risk-checklist is
   *not* a front gate; it's an **end-of-pipeline completeness verifier**
   (additive only — can catch a miss, never cause one).
5. **Premium reads the richest available source per agent.** For Claude that is
   the **raw JSONL** (thinking + tool calls + causal context), NOT the existing
   text-only `getTranscript` — the deep-dive's whole value is having richer
   material than the cheap summary ever saw.

---

## 3. Drop / compress / verbatim rules

The governing principle: **represent everything the model actually saw; drop only
what it never saw or already lost.**

- **Drop** (safe — never in context or already evicted): base64 image blobs and
  oversized file dumps we already strip in `sanitizeEntry`/`repairSession`; tool
  output past the agent's own tool-result eviction.
- **Compress, don't delete** (anything the model read and reasoned over —
  *including tool results*): render it as the decision/finding it produced
  ("ran `az ad sp show` → blocked by Zscaler → switched to Portal lookup"). The
  raw output collapses to the fact that mattered; the signal survives.
- **Verbatim** (never summarized): the recent window + the pinned-facts block.

Why this matters (the two motivating cases):
- **Reactive user interjections** — "I see you keep searching for the key, here
  it is, document this" is a non-sequitur without the agent-thrashing context
  that triggered it. Preserve the **causal neighborhood** of user messages,
  especially terse reactive ones; the message itself is a high-value pinned fact.
- **Self-coaching in thinking** — agents often decide/learn things in thinking
  ("stop using the alias, use full IDs") that never surface in a visible message.
  **Thinking is a first-class extraction source**, not optional.

---

## 4. Architecture — a Workflow pipeline

The premium routine maps cleanly onto the `Workflow` tool (fan-out → reduce →
fan-out → synthesize → critic). Each stage is an `agent()` call; each I/O contract
is the `schema` on that call.

```
            ┌─ richest-source reader (raw JSONL for Claude; store text otherwise)
            │
   sources ─┤─ Discord gap-detector (§5) → pull Discord ONLY for ranges where it
            │                                 out-fidelities the session
            ▼
   [CHUNK] split combined sources at safe (<1M) boundaries, preserving structure
            │
   fan-out ▼   (1) Chunk analyzer  — one agent per chunk
            │
   barrier ▼
   reduce      (2) Meta-analyzer   — one agent: consolidate + emit work-list
            │       (purpose/milestones/decisions/learnings + risk checklist +
            │        per-region best-source + deep-dive ranges + recency weight)
            ▼
   fan-out     (3) Deep-dive       — one agent per region, UN-GATED, all regions
            │       (4 extraction targets), depth tuned by checklist
            ▼
   reduce      (4) Synthesizer     — one agent: final structured summary
            │   (+) Pinned-facts extractor (6) — verbatim load-bearing items
            ▼
   verify      (5) Completeness critic — checklist items preserved? recover misses
            ▼
   assemble    new session = framing + summary + verbatim recent window +
               verbatim pinned facts  (→ manager.compactSession)
```

Reduce-step sizing is fine: a 1M session → ~2 chunks → ~80–160K of sub-summaries
→ trivially fits the meta-step window. Add a recursive reduce only if a
transcript is absurdly large (>~30 chunks); not a v1 concern.

---

## 5. Mandatory Discord gap-detection + per-range source selection

Run **always** (cheap — timestamps/counts/markers, no LLM). Fire on **any**:
1. **Pre-history gap** — session's earliest entry timestamp > thread's earliest
   message (thread predates this session).
2. **Attachment swap** — thread has had >1 `acp_session_id` over its life.
3. **Prior in-session compaction** — `compact_boundary`/`isCompactSummary` in the
   JSONL → the session is already a summary before that point.
4. **Time discontinuity** — a gap in the session's entries the thread fills.

On any hit, pull Discord **only for the affected ranges**, and apply per-range
**highest-fidelity source selection**: where the session is full-fidelity, prefer
it (it has thinking/tool calls Discord lacks); where it's summary-only or absent,
Discord wins for that range. This de-dupes automatically — Discord is only
analyzed where it beats the session.

---

## 6. The prompt suite (with I/O contracts)

These are interdependent — each `out` is the next stage's `in`. Draft text below;
all need empirical tuning (§10).

### (1) Chunk analyzer
- **in**: `{ chunkIndex, source: "session"|"discord", timeRange, text }` — one
  structure-preserving chunk (incl. thinking/tool context for Claude session).
- **out (schema)**: `{ chunkIndex, timeRange, topics[], decisions[], userCorrections[], selfCoachedRules[], openThreads[], toolFindings[], notableQuotes[] }`
  — each item carries an approximate timestamp/anchor.
- **prompt (draft)**:
  > You are analyzing one chunk of a longer agent work session for a high-fidelity
  > compaction. Do not summarize for brevity — your job is to *index* this chunk so
  > a later stage can decide what must be preserved. Extract, with an approximate
  > timestamp/anchor for each: (a) topics/threads of work; (b) concrete decisions
  > made and why; (c) **user corrections or coaching** (terse reactions included —
  > note what activity triggered them); (d) **rules the agent coached itself on in
  > thinking** that may not appear in visible messages; (e) open/unresolved threads;
  > (f) tool findings that changed the course of work (the finding, not the raw
  > output); (g) short verbatim quotes that are load-bearing. Be exhaustive over
  > signal; ignore only pure noise (file dumps, command spew) that drove no decision.

### (2) Meta-analyzer / reducer  *(keystone)*
- **in**: all chunk-analysis objects (+ Discord-range analyses).
- **out (schema)**: `{ purpose, milestones[], decisions[], lessonsLearned[], openThreads[], recencyWeighting, riskChecklist[ {item, whereBestSourced, severity} ], deepDiveTargets[ {timeRange, source, why, depth:"normal"|"deep"} ] }`.
- **prompt (draft)**:
  > You are consolidating per-chunk analyses of one work session into a single
  > structured picture, and producing a work-list for deep extraction. De-dupe and
  > organize into: the thread's original purpose; key milestones; major decisions;
  > valuable lessons learned; still-open threads. Then produce a **risk checklist**:
  > every item whose loss of sharpness would be costly, each tagged with where it is
  > best sourced (session / Discord / both). Decide whether recent activity deserves
  > extra weight or some other region does. Finally, emit **deep-dive targets** —
  > the timestamp ranges worth a detailed second read, the source to read, why, and
  > whether normal or deep treatment. Cover the whole session; flag the highest-risk
  > regions for deep treatment, but target every region.

### (3) Deep-dive extractor  *(un-gated, all regions)*
- **in**: `{ timeRange, source, depth, fullText }` — the actual richest-source
  text for that range + the four targets.
- **out (schema)**: `{ timeRange, narrative, causalPairs[], selfCoachedRules[], userCorrections[], decisions[], artifacts[] }`.
- **prompt (draft)**:
  > Produce a faithful, detailed rendering of this region of the session — enough
  > that a fresh agent could resume the work without re-reading the original.
  > Capture especially: **causal pairs** (agent activity + the user interjection
  > that reacted to it — keep the user side verbatim, with enough trigger context
  > to understand *why* it was said); **self-coached rules** from thinking;
  > **user corrections/coaching** verbatim; concrete decisions and their rationale;
  > and durable artifacts (file paths, IDs, commands, constraints). Compress raw
  > tool output to the findings it produced; never drop a finding that changed the
  > work. Match the established voice.

### (4) Synthesizer
- **in**: all deep-dive outputs + the meta-analysis.
- **out**: the final structured summary —
  `## Purpose / ## Current state / ## Open threads / ## Decisions & rationale / ## Pinned constraints (verbatim) / ## Recent window (pointer)`.
- **prompt (draft)**:
  > Assemble the deep-dive extractions and the meta-analysis into the session's
  > resumption summary. Structure it as: Purpose; Current state (where things stand
  > right now); Open threads (what's unfinished); Decisions & rationale; Pinned
  > constraints (carried verbatim from the pinned-facts block). Favor specificity
  > over prose — this is a working brief for resuming, not a narrative. Do not
  > restate the verbatim recent window; it is appended separately.

### (5) Completeness critic  *(inverted gate — additive only)*
- **in**: synthesized summary + risk checklist.
- **out (schema)**: `{ verdicts[ {checklistItem, preserved:boolean, evidence} ], recoveries[ {timeRange, source, what} ] }`.
- **prompt (draft)**:
  > Audit this compaction against the risk checklist. For each checklist item,
  > decide whether the summary preserves it with enough fidelity to resume safely,
  > citing where. For any item that thinned out or vanished, emit a targeted
  > recovery request (which range/source to re-read and what to recover). Default
  > to "not preserved" when uncertain — a false miss is cheap, a real loss is not.

### (6) Pinned-facts extractor  *(shared with default tier)*
- **in**: richest-source transcript (or, for default tier, the cheap transcript).
- **out (schema)**: `{ corrections[], constraints[], decisions[], openTodos[], activePaths[], rules[] }` — all **verbatim**.
- **prompt (draft)**:
  > Extract only the load-bearing, must-not-lose facts, verbatim. Include: explicit
  > user corrections/rules ("never do X", "always do Y", "here is the fact you kept
  > missing"); active constraints; firm decisions; open TODOs; active file paths /
  > IDs / commands; and rules the agent coached itself on in thinking. Quote exactly
  > — do not paraphrase. If the list is large, order by how costly each would be to
  > lose, and keep the highest-cost items.

### (7) Default-tier summarizer
- The existing single-pass `compact.md`, augmented to also emit the pinned-facts
  block (via prompt 6's targets) and a drop-note. Keeps verbatim recent window.

### (8) Session-seed / pre-warm framing  *(assembled artifact, not an LLM call)*
- The first turn of the new session:
  > _[system/context — the user does not see this message and expects to continue
  > seamlessly] Your session was compacted to free context. Below is a faithful
  > summary of the work so far, the must-preserve constraints, and the most recent
  > exchanges verbatim. Resume as if no interruption occurred._
  > → followed by: structured summary (4) + pinned facts (6, verbatim) + the last
  > K turns verbatim.

---

## 7. New-session assembly shape

```
<pre-warm framing (8)>
<structured summary (4)>
<pinned constraints (6), verbatim>
--- recent context (verbatim) ---
<last K turns, word-for-word>
```
Written via the agent's `manager.compactSession(cwd, newSessionId, assembled)`.
K = token-budgeted (e.g. last ~15% of the window) rather than a fixed count, so it
scales with window size.

---

## 8. Integration

- **Button**: add "✨ Premium Compact" to the `/seam sessions` panel (next to
  Compact / Rebuild / Migrate / Import), gated to agents whose `sessionManager`
  supports `compactSession` + a transcript reader.
- **Richest-source reader**: new `getRawTranscript`/`getStructuredHistory` on the
  Claude session manager that returns thinking + tool context (the existing
  text-only `getTranscript` stays for the cheap path). Other agents return their
  best available; the routine degrades gracefully.
- **Execution**: the button kicks off the §4 Workflow (or an equivalent inline
  fan-out). It runs in temp agents reading from disk — never the live session.
- **Result**: re-anchor the thread to the new session id (as `/compact` and Import
  already do), post the drop-note, and the completeness-critic's verdict summary.

---

## 9. Build-time open items (specify during build; non-blocking)

- Recent-window K exact budget; pinned-facts block cap/prioritization.
- Discord↔session timestamp-range alignment mechanics.
- Subagent failure handling (partial vs abort-and-keep-original — default: keep
  original, never destroy the source session until the new one is written).
- Whether prompts live as template files or inline workflow strings.
- Per-agent richest-source reader implementations (Claude first; agy/Copilot best-
  effort).

---

## 10. Verification plan (non-negotiable — same discipline as the model work)

A premium compaction is **not done until proven** to preserve load-bearing signal:
1. Pick a real heavy session as the test corpus (e.g. spg, or a ridgeline session).
2. Run the routine; diff the output against the ground-truth transcript.
3. Manually seed a checklist of known load-bearing facts (corrections, thinking-
   only rules, causal interjections) and confirm each survived.
4. Resume the compacted session with a prompt that depends on a preserved detail;
   confirm the agent continues seamlessly.
5. Tune the prompts against the misses; repeat until the checklist is clean.

Only after that does the premium tier earn the "premium" label.
