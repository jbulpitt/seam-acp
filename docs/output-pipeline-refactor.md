# Output pipeline — consolidate the streaming markdown model

**Status:** proposal / analysis (NOT greenlit) · **Created:** 2026-06-06 · **Owner:** jbulpitt

The streaming output path (agent text → Discord messages) is *functional but fragile*: it
handles structured markdown constructs with **three separate, overlapping mechanisms**.
That's the source of the fence/chunk anomalies we still live with, and it makes the area
risky to touch. This is a proposal to **re-implement what we already have, better** —
consolidate those three into one **streaming markdown block model** — for maintainability
and to retire the anomalies. It is not a new feature; it's a quality/robustness refactor.

> **Legend** — `[decided]` · `[proposed]` · `[must-preserve]` · `[research]` · `[risk]`.

## 0. Non-goals

- **Tables are out of scope — already solved.** A harness-level per-prompt instruction
  tells agents to put tabular data in fenced `text` blocks. Those are just ``` fences, so
  they flow through the **existing fence path** (inline, or file when large) with zero
  table-specific code. No table block type, no table transform — nothing to build here.
- This refactor adds **no user-visible feature.** Success = identical (or better) output
  with one coherent implementation instead of three.

## 1. Why touch it at all

- We **still live with fence/chunk anomalies** (fences occasionally split or render wrong).
- The area is **high-friction to change** — multiple bug-fixes have accreted across three
  components that each know about *some* constructs and trust the others to handle the rest.
- Every future output tweak pays that complexity tax.

## 2. Current-state map

Three mechanisms, no single obvious home:

| Component | File | Role | Construct awareness |
|---|---|---|---|
| `FenceStream` | `src/core/fence-stream.ts` | **Streaming extractor** — pulls ``` fences *out* of the raw stream into `prose` / `fence-open` / `fence-close(content)` segments. Pure state machine; split-across-chunks safe; `flush()`/`forceClose()`. | fences only |
| `splitForFlush` | `src/core/stream-flush.ts` | **Streaming prose splitter** — when/where to cut the prose buffer. Link/image-aware (`findFirstUnsafeIndex`), inline-code-aware (`isInsideInlineCode`), paragraph/line/sentence (`findCleanSplit`), `---` thematic-break (`findThematicBreakCut`). Body *trusts fences are already gone* (~line 260). | links, inline-code, thematic breaks — **NOT fences** |
| `chunkForDiscord` | `src/core/text-chunker.ts` | **Batch splitter** (used by `renderer.ts`) — naive size + newline split. | **none** |

**How "don't split a fence" actually works today:** it doesn't — `FenceStream` *removes*
fences before either splitter runs, so the splitters never see one. The fragile seam is a
fence **re-embedded** as an inline ```…``` (short snippet) flowing through a fence-blind
splitter, especially the naive batch `chunkForDiscord`; and the **divergence** between the
two splitters (streaming vs batch behave differently).

**Fence render decision** lives in the orchestrator (`emitClosedFence`,
`src/platforms/discord/orchestrator.ts:5043`), gated by `ORCH_INLINE_FENCE_MAX = 1900`:
inline ≤ 1900 → ```lang …``` message; > 1900 → **upload as a file**; bare-filename → real
host file (≤ 25 MB); watchdog (`FENCE_MAX_OPEN_MS = 60_000`) → force-close + notice;
unclosed-at-flush → emit snapshot.

## 3. Diagnosis

Every "don't cut inside this construct" rule is handled by a *different* mechanism — fences
by extraction, links/inline-code/thematic-breaks by `splitForFlush`, nothing by
`chunkForDiscord`. **Three overlapping systems for one problem.** The anomalies live in the
seams between them (re-embedded fence → fence-blind splitter; streaming vs batch divergence).

## 4. Proposed design — one streaming block model

Collapse the three into **one streaming markdown *block* tokenizer + one block-granular
splitter**, where "never cut inside a block" is the *default*, not a special case.

- **`[proposed]` Block tokenizer** (generalize `FenceStream` — it's already a
  single-block-type version): segments the stream into typed blocks — `paragraph`,
  `code_fence`, and naturally extensible to `list` / `blockquote` / `thematic_break` —
  with the same split-across-chunks/flush robustness `FenceStream` has today.
- **`[proposed]` Splitter** packs **whole blocks** into messages, cutting only **between**
  blocks. "Never split a fence" becomes the default.
- **`[proposed]` Per-block overflow policy** — the *only* place an internal cut happens:
  - `paragraph` too long → sentence/line split **with inline-awareness** (today's
    `splitForFlush` link/inline-code logic, scoped to exactly this case);
  - `code_fence` too long → **upload as a file** (the current behavior — §5).

**Wins:** one logical home for "don't break structure"; the streaming-vs-batch divergence
disappears (both paths feed the same tokenizer); it attacks the *class* of bug instead of
adding another mechanism; and the area becomes safe to extend later.

## 5. Behaviors that MUST survive `[must-preserve]`

The refactor **relocates** these into the `code_fence` block's render/overflow policy —
same behavior, clearer home. (Pinned in `test/output-pipeline-golden.test.ts`.)

1. **Oversized fence → file** (inline render > 1900 ⇒ file attachment, ext/MIME from lang).
   *Canonical policy — NOT "close+reopen across messages".*
2. **Bare-filename fence → real host file** (allowed roots, ≤ 25 MB).
3. **Watchdog**: fence open > 60 s → force-close + notice.
4. **Unclosed-at-flush** fence → emit snapshot.
5. **Link/image + inline-code split safety** → preserved inside the `paragraph` policy.
6. **`---` thematic break** as an explicit message boundary.

## 6. Risk `[risk]`

**High inherent risk, controllable with discipline; big-bang = very high.**

- **Maximal blast radius** — every agent's output, every thread, every turn.
- **Edge-case density** — each line is a past bug fix; a rewrite can re-introduce them
  (Chesterton's fence, literally).
- **Live behavior is hard to test** (streaming + timing + Discord).

Mitigants: the hard logic is **pure** (`FenceStream`/`splitForFlush`/`chunkForDiscord`) →
unit-testable; **incremental + behavior-preserving** per step; **trivial rollback** (behind
a flag); **shadow-run** (new pipeline alongside old, diff on real traffic). Catch: **no
clean baseline** — define *desired* output via the golden corpus (§7), don't preserve bugs.

## 7. Golden corpus (oracle — already built) `[decided]`

`test/output-pipeline-golden.test.ts` (commit `9212b76`) — no production code touched. Pins
the fence→file routing contract + the must-survive behaviors (§5) as executable assertions
+ `it.todo`. Regression net for the current code **regardless** of whether the refactor
proceeds. (7 passing + 5 todo.) *(It also documents today's table pass-through behavior;
harmless to keep.)*

`[research]` Expand it with a handful of **real captured agent outputs** (a fence split
weirdly across chunks, a > 1900 fence, prose + links) so the first PR validates against
reality, not just synthetic inputs.

## 8. Incremental migration plan `[proposed]`

Each step ships + reverts independently; behavior-preserving throughout.

0. **Expand the golden corpus** with real captured outputs (§7). No prod code.
1. **PR1 — generalize `FenceStream` → `BlockStream`** emitting `paragraph` + `code_fence`,
   **behavior-preserving**, behind a flag (old path default). Verify against the corpus.
   *Lowest-risk real-code step; zero user-visible change.*
2. **PR2 — route the batch path through it** (retire `chunkForDiscord`'s independent
   logic) → kills the streaming-vs-batch divergence.
3. **PR3 — move `splitForFlush`'s inline logic into the `paragraph` overflow policy**, and
   remove the apparent legacy fence-reopen branch in `splitForFlush` (§10).

That's the whole consolidation — no further phases needed for current functionality.

## 9. Decision status

- **Not greenlit.** Driven by **anomaly pain + maintainability**, not a feature deadline.
- Recommended order if pursued: **§7 expand corpus → §8 PR1**, then reassess from data.

## 10. Open questions `[research]`

- Extract the `emitClosedFence` decision into a **pure function** so the §5 routing contract
  becomes a real integration test (not just a mirror in the corpus).
- Reconcile the apparent fence-reopen logic in `splitForFlush` (its tests reference it) vs.
  the "fences are gone upstream" comment — likely legacy/dead; remove in PR3.

## 11. Related
- Oracle: `test/output-pipeline-golden.test.ts`.
- Current code: `src/core/fence-stream.ts`, `src/core/stream-flush.ts`,
  `src/core/text-chunker.ts`, `src/platforms/discord/renderer.ts`,
  `src/platforms/discord/orchestrator.ts` (`emitClosedFence` ~5043).
