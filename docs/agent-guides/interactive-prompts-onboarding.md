# Interactive prompts — onboarding prompt (consuming projects)

Paste **1** into a project that does **not** yet have seam frozen-choice-card
context. That agent should fetch the canonical guide, hang the raw URL in its
own library, and overlay only that repo.

Canonical spec (do not fork):
`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md`

This is the **software / team** version (not the school / microsite one).
Updated 2026-08-22 for multi-select (`#94`, `fd5a5e5`).

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
- HTTP ingest: a page or tool POSTs /ingest with the site Bearer. Mint via create_choice ingress only (fence will not mint a token). The scoring/handling turn MUST submit_result (or a seam-result fence) — that JSON is the HTTP body, not the Discord transcript. Public: https://ingest.runbooksynthesis.com/ingest — POST ?wait=0 then poll GET /ingest/jobs/{id}. Persist artifacts in this repo as the wrapper says.

After writing the library entry, confirm: file path(s), the raw guide URL is in them, and a brand-new session would use live single-user cards by default.
```

**2. Short nudge** if they already stored an older version:

```
Update the interactive-prompts library entry from
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md
Default is live, single-user: one pick, card shows the choice, buttons disappear. Several picks from one person: select (dropdown + Confirm → one combined prompt). maxClicks > 1 only for multi-user. Ingest is advanced. This project is software/team, not a classroom. Say which file you changed.
```
