# Interactive prompts — onboarding prompt (consuming projects)

Paste **1** into a project that does **not** yet have seam frozen-choice-card
context. That agent should fetch the canonical guide, hang the raw URL in its
own library, and overlay only that repo.

Canonical spec (do not fork):
`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md`

This is the **software / team** version (not the school / microsite one).
Updated 2026-08-22 for multi-select (`#94`) and headless ingest endpoints
(`#95`, including `preset` resolved at fire).

---

**1. Persist into that project’s context library** (use this)

```
Seam-acp interactive prompts are a KEY SKILL for this project: structured in-thread decisions, review gates, and (when needed) HTTP ingest from tools/UIs you build. Persist this into the project context library (AGENTS.md, rider, docs/agent-context, CLAUDE.md, etc.) so NEW sessions see it without this message.

Fetch and keep this guide (re-read it now):
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md

Link that URL in the library. Overlay only THIS repo (cwd, tokens, persist paths). Do not fork the protocol.

Persist these facts:

DEFAULT USE (do this constantly)
- A choice card is a structured question IN THIS LIVE THREAD: ship/don't ship, pick a plan, pick a worker path.
- Publish with create_choice or a seam-choice fence. Small JSON is enough: title + options with kind "prompt" and a payload. defaultTarget is live; omit maxClicks.
- Default is SINGLE-USER: one person, one pick. After they click, the card shows what they selected and the BUTTONS GO AWAY (not left disabled).
- Several picks from one person: add select: { min?, max? } — dropdown + Confirm, one combined prompt listing the ticks, then freeze as Selected: A, B, C. Still one person, one Confirm. All options must be kind "prompt"; select + custom or maxClicks>1 is rejected. Details: Multi-select in the guide.
- targetUserId only restricts WHO may click — it is still single-user.
- Set maxClicks > 1 ONLY when several people should each click (review vote, several operators). Then buttons stay until the cap. If unsure, omit maxClicks.
- Participants may click. They must not create or cancel.

WHEN YOU NEED MORE (same guide, later sections)
- isolated = throwaway session, output still in the card thread (don't pollute this session).
- thread = another seam snowflake, live there (e.g. send a frozen prompt to a QA thread).
- HTTP ingest (microsite, no Discord card): MCP create_ingest. Isolated silent scoring. POST {text, studentId?} does not choose agent/model. Pin those at mint, inherit this thread, or set preset (resolved at each POST — edit the preset to change the grader without reminting). Cannot combine preset with agent/model/effort/cwd. Token once; inject at build/serve. Public: https://ingest.runbooksynthesis.com/ingest — POST ?wait=0 then poll. Declare JSON with submit_result. persist in this repo. Card-bound ingest (create_choice + ingress) still exists for Discord click-cards.

After writing the library entry, confirm: file path(s), the raw guide URL is in them, and a brand-new session would use live single-user cards by default.
```

**2. Short nudge** if they already stored an older version (cards only):

```
Update the interactive-prompts library entry from
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md
Default is live, single-user: one pick, card shows the choice, buttons disappear. Several picks from one person: select (dropdown + Confirm → one combined prompt). maxClicks > 1 only for multi-user. Ingest is advanced. This project is software/team, not a classroom. Say which file you changed.
```

**3. Refresh snippet** for a project that already pinned the guide (cards + ingest):

```
Re-fetch and keep this canonical guide (it grew):
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md
Update the project context library overlay (do not fork the protocol). New facts:

- Multi-select cards: select:{min,max} → dropdown + Confirm, one combined prompt. Still one person. No custom options, no maxClicks>1.
- Headless ingest endpoints (#95): MCP create_ingest (no Discord card). Same POST /ingest + submit_result. Isolated silent. Retries unlimited unless uniqueStudent. POST body is only {text, studentId?} — it does not pick agent/model.
- Who scores: create_ingest.preset (a project preset, resolved at each POST so you can tweak model/effort/instructions without reminting) OR pin agent/model/effort/cwd OR inherit the minting thread. preset cannot combine with agent/model/effort/cwd.
- Wrapper = assignment contract (rubric, persist path, resultSchema). Preset = grader identity. Keep those separate.
- Token shown once; inject at build/serve, not in page JS. Public host https://ingest.runbooksynthesis.com/ingest — POST ?wait=0 then poll GET /ingest/jobs/{id}. Persist attempts in THIS repo.

Say which file(s) you changed. A brand-new session must see these without this message.
```
