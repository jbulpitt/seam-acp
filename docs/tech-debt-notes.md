# Tech-debt notes

**Status:** assessment / register · **Created:** 2026-06-05 · **Owner:** jbulpitt

An honest, evidence-grounded read of the app's anti-patterns and how the
[seam-bridge plan](./seam-bridge-plan.md) intersects them. **This is a register, not a
committed work plan** — items are tagged by how they relate to the bridge work.

> **Legend** — `[retired-by-plan]` cleaned up as a side effect of building the bridge ·
> `[mind-during-plan]` cheap to fix while you're already in that code ·
> `[out-of-scope]` real debt the plan does **not** touch (separate effort) · `[done]`.

---

## Top-line

**Moderate, *concentrated* debt — not rot.** Across ~17.6k src LOC there are only **13
TODO/HACK markers** (12 of them in one file) and **52 `as any`** (clustered at external
JSON-parse boundaries) — low for the size. The weight is **structural**: the top 3
files are **~45% of the codebase**, and one file is **34%**.

| File | LOC | Note |
|---|---|---|
| `src/platforms/discord/orchestrator.ts` | 5,971 | god object (A1) |
| `src/agents/profiles/agy.ts` | 1,699 | holds 12/13 hack markers (C4) |
| `scripts/remote-agent-bridge.mjs` | 957 | untyped; duplicated session logic (A2) |

## Inventory

**A. Structural**
- **A1 `[out-of-scope]` God-object `orchestrator.ts` (5,971 LOC)** — turn lifecycle +
  every slash command + pickers + rendering + session UI + scheduled prompts +
  image-gen. Highest blast radius. The plan *touches* it and risks **growing** it — see
  mind-during (C2-adjacent) below.
- **A2 `[retired-by-plan]` Session-logic duplication** — claude/copilot session access
  lives in *both* the typed profiles and the untyped `.mjs` bridge. → **D3** co-located
  adapters: one implementation, run wherever the agent runs.
- **A3 `[retired-by-plan]` Identity/location conflation** — "remote" is a flattened
  copilot-shaped profile that drops `effort`/`newSessionMeta`/`whoami`. → **D1/D9**
  location-as-binding.

**B. Pragmatic hacks (isolated, justified-but-smelly)**
- **B1 `[resolved]` ~~`patch-acp` monkey-patches a `node_module` dist~~** — retired at
  `claude-agent-acp` 0.54.1: `setSessionConfigOption` exact-matches full canonical IDs
  before the fuzzy resolver, so the resolver-bypass patch is no longer needed. The
  script and the `npm run patch-acp` command have been deleted.
- **B2 `[retired-by-plan]` cwd-rewrite** string-munges ACP messages to swap paths. →
  **§7** workspace-at-host; deleted in **PR0**.
- **B3 `[retired-by-plan]` raw-SQL string-building + `sqlite3`-CLI shelling** in the
  bridge (`escapeSql`/`execSql`). → session access moves into the typed adapter.

**C. Hygiene**
- **C1 `[out-of-scope]` Test discipline** — 4 known-failing tests ignored; ~3:1
  src:test file ratio. The plan adds bridge **conformance tests** (good habit to
  spread) but doesn't fix the 4.
- **C2 `[mind-during-plan]` Config sprawl** — 507 LOC of stringly-typed env parsing
  with bespoke formats. The bridge will add config; use a **structured file**, not more
  `REMOTE_*`-style env parsing, so `config.ts` doesn't get worse.
- **C3 `[mind-during-plan]` `as any` at parse boundaries (52)** — defensible (untyped
  ACP/JSONL/SQLite JSON) but loose. Tighten in the four profiles during **PR1** —
  they're being rewritten anyway.
- **C4 `[out-of-scope]` `agy.ts` (1,699 LOC)** holds 12 of the 13 hack markers — its
  own cleanup, low synergy with the bridge work.

## How the plan intersects

| Anti-pattern | Plan effect |
|---|---|
| A2 session duplication | **Eliminated** — D3 co-located adapters |
| A3 identity/location | **Fixed** — D1/D9 |
| B2 cwd-rewrite | **Deleted** — §7 / PR0 |
| B3 raw-SQL `.mjs` | **Fixed** — typed adapter |
| untyped `.mjs` bridge | **Fixed** — PR2 monorepo (TS + shared adapters) |
| dead remote code | **Deleted** — PR0 |
| naming sprawl | **Fixed** *if* the naming resolver (D10) is done |
| **A1 orchestrator** | **Not addressed — likely grows** (selection UI, `/seam bridge`, `/seam debug` land there) |
| B1 patch-acp | **Resolved** — patch retired at claude-agent-acp 0.54.1 (upstream exact-match fix) |
| C1 tests | Partly helped; 4 failures remain |
| C2 config sprawl | **At risk of growing** unless bridge config is a structured file |
| C3 `as any` | Opportunity in PR1 |

**Net:** the bridge plan is **debt-reducing by construction** — it retires the entire
remote/bridge cluster (A2, A3, B2, B3, untyped `.mjs`, dead code) for free, but leaves
A1 and risks worsening A1/C2 if you're not deliberate.

## During / adjacent — tiers

- **Free (it *is* the plan):** A2, A3, B2, B3, `.mjs`→TS, dead code.
- **Cheap in-flight (do while you're in that code):** C3 (PR1 types), naming resolver
  (D10), C2 (structured bridge config).
- **Targeted only — don't boil the ocean:** A1 — extract *only* the orchestrator pieces
  the plan adds (`/seam bridge`, `/seam debug`, selection UI) into their own modules so
  it doesn't grow and decomposition starts where you're already working. A **full**
  orchestrator teardown is a separate project — high risk for a daily-driver app.
- **Leave alone now:** C1 broad test coverage · C4 agy cleanup. *(B1 patch-acp is resolved — patch retired at 0.54.1.)*

## Related
- [seam-bridge-plan.md](./seam-bridge-plan.md) — §3 "debt retired", §9 "debt
  discipline" wire the in-scope items into the PRs.
