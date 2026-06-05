# Standardized Integration Skills — feasibility research

**Status:** research scaffold · **Created:** 2026-06-05 · **Owner:** jbulpitt

Placeholder + research tracker for additional **integrations packaged as reusable
skills** (read messages, fetch assignments, control devices, etc.). Not strictly
seam-acp — these would ideally be standardized skills any agent could call, and may
spin out into their own thing.

> ⚠️ Initial reads below are from a Jan-2026 knowledge cutoff and **must be
> verified** — APIs, ToS, and anti-bot measures move fast. Treat each "initial
> read" as a hypothesis to confirm with a spike.

> **Legend** — `[research]` needs a spike · `[idea]` · `[decided]` · `[blocked]` ·
> `[done]`. Per item: **Goal · Sanctioned options · Unofficial options ·
> Feasibility (initial read) · Risks · Research tasks.**

---

## Two natural groupings

- **Group A — Sanctioned APIs** (official auth + documented API): Gmail, Discord,
  Google Home, "Gemini Spark"(?). Tractable; the work is OAuth/app setup + polling
  vs push.
- **Group B — Locked-down platforms** (org admin disables formal apps): MS Teams,
  Slack, Canvas. Here the question is *unconventional* access — browser automation
  or undocumented endpoints — with real ToS/detection risk. These share one
  substrate (see [§ Cross-cutting](#cross-cutting-concerns)).

---

## Group A — Sanctioned APIs

### Gmail — "what options are available"
- **Goal:** read mail / detect new mail (and maybe send) on a user's behalf.
- **Sanctioned options:**
  - **Gmail API** (REST) + OAuth 2.0 scopes (`gmail.readonly`, `gmail.modify`, …).
  - **Push** via `users.watch()` → Cloud Pub/Sub (real-time new-mail events) vs.
    **polling** `history.list`.
  - **IMAP/SMTP** (simpler, no Cloud project, but coarser).
  - **Existing MCP servers** — incl. the `claude.ai Gmail` MCP already present in
    this environment (search/threads/labels/drafts). Cheapest path to "just works."
- **Feasibility (initial read):** **High.** The most tractable of all of these.
- **Risks:** OAuth consent-screen verification for sensitive scopes; per-user token
  storage + refresh; Workspace admins can restrict third-party apps.
- **Research tasks:**
  - [research] Compare: claude.ai Gmail MCP vs. own OAuth app vs. IMAP — pick the
    standard.
  - [research] Push (Pub/Sub `watch`) vs. polling for "new message" triggers.
  - [research] Multi-account token storage model (reuse the per-agent configDir idea?).

### Google Drive / Google Docs — read/search/fetch (+ optional edit)
- **Goal:** list/search Drive files, read document content (Docs/Sheets/Slides),
  optionally create/edit, and detect new/changed files.
- **Sanctioned options:**
  - **Drive API** (REST) + OAuth — `files.list` (query/search), metadata,
    download/export (e.g. export a Doc → text/markdown/PDF), permissions.
  - **Docs API** for structured read/write of a document body (vs. flat export);
    **Sheets/Slides APIs** for those types.
  - **Change detection:** `changes.watch` / `files.watch` **webhooks**, or poll
    `changes.list` with a saved page token.
  - **Existing MCP** — the `claude.ai Google Drive` MCP is already present in this
    environment (search_files, read/download content, create_file, metadata,
    permissions, recent files). Likely the fastest path, same as Gmail.
- **Unofficial options:** not needed — the official API is robust.
- **Feasibility (initial read):** **High.** Same Google OAuth family as Gmail; well
  documented; MCP may be a free win.
- **Risks:** scope sensitivity (`drive.file` ⊂ `drive.readonly` ⊂ full `drive` —
  broad scopes need OAuth verification); per-user token storage/refresh; export
  fidelity for complex docs; rate limits; Workspace admin restrictions.
- **Research tasks:**
  - [research] claude.ai Google Drive MCP vs. own OAuth app — pick the standard.
  - [research] **Scope minimization** (prefer `drive.file`/readonly over full drive).
  - [research] Content read strategy: **Docs API** (structured) vs. **Drive export**
    (Doc → markdown/text) — which is cleaner for agent consumption.
  - [research] Change triggers: `changes.watch` webhooks vs. page-token polling.
- **Note — Google Workspace cluster:** Gmail + Drive/Docs (+ Calendar, already an
  MCP here) share one OAuth + the same claude.ai MCP set. Worth designing **one
  Google auth/token substrate** that all three reuse rather than three separate
  integrations. (Also mirrors Gemini Spark's connector set — see that entry.)

### Discord — "general message retrieval"
- **Goal:** retrieve messages beyond seam-acp's own bot threads (channels/history).
- **Sanctioned options:** Discord **Bot API** with the **Message Content intent** +
  read permissions in guilds the bot is in (`GET /channels/{id}/messages`,
  history, search). seam-acp already holds a bot connection to build on.
- **Unofficial options:** user-token / "selfbot" to read as a *user account* —
  **against Discord ToS, risks account ban.** Avoid unless throwaway.
- **Feasibility (initial read):** **High for bot-scope**, **Low/risky for user-scope.**
- **Risks:** Message Content is a privileged intent (verification at scale); can't
  see guilds the bot isn't a member of.
- **Research tasks:**
  - [research] Define the actual scope — *whose* messages, which channels?
  - [research] What's already reachable via the current bot vs. net-new.

### Google Home — device state / control
- **Goal:** read state and/or control Home devices from a headless server/bot.
- **Sanctioned options:** Google **Home APIs** (SDKs are largely mobile/Android-iOS
  focused); **Assistant SDK** (legacy, shrinking); Smart Home **Actions** (for
  *exposing* your own devices, not generic control).
- **Unofficial / pragmatic:** use **Home Assistant** as an intermediary that talks
  to Google/Matter/local, and integrate against *its* clean API. Likely the path of
  least resistance for server-side control.
- **Feasibility (initial read):** **Medium-Low** server-side direct; **Medium** via
  a Home Assistant bridge.
- **Risks:** Google has deprecated several control paths; mobile-only SDKs; auth for
  headless control is awkward.
- **Research tasks:**
  - [research] Is there a *current* server-usable Google Home control API, or is HA
    the realistic substrate?
  - [research] Matter/local-control angle.

### Gemini Spark — Google's own cloud agent · `[research]` resolved: **no public API**
- **What it is** (Google docs, fetched 2026-06-05): Google's autonomous *"24/7
  personal AI agent."* A **Tasks / Skills / Schedules** model that runs in the
  background across your Google apps, drives a **remote browser**, and **executes
  code on remote computers** — checking in before major actions.
- **Runs on:** Gemini 3.5 Flash **+ Antigravity** — i.e. the *same* Antigravity
  engine behind seam-acp's `agy` agent.
- **Connects to (opt-in):** Gmail, Calendar, Drive, Docs, Sheets, Slides, YouTube,
  Maps.
- **Availability:** trusted-tester → **Google AI Ultra**, 18+, **US-only**,
  English-only, personal Google Account, Activity on. Cap ~15 concurrent tasks.
- **Integration feasibility: ❌ none right now.** **No API / developer /
  programmatic access** is documented — integration is *Google's own* Connected
  Apps + skills framework, no third-party endpoints. You can *use* it (with AI
  Ultra) but not *drive* it from seam-acp. Scraping a first-party Google agent app
  would be very brittle + ToS-hostile — not worth it.
- **Why it still matters (landscape, not a target):** Spark is essentially
  *Google's version of what seam-acp is becoming* — on the same Antigravity engine.
  Parallels worth tracking:
  - Spark **Skills** ≈ this doc's "standardized integration skills."
  - Spark **Schedules** ≈ seam-acp's `ScheduledPromptManager`.
  - Spark **Antigravity** backend ≈ the `agy` agent.
  - Spark **Workspace connectors** ≈ Group A (Gmail/Calendar/Drive) here.
- **Watch tasks:**
  - [research] Re-check periodically for a **Spark / Gemini-agent API** — that would
    flip this from "landscape" to "integration target."
  - [idea] Mine Spark's public surface for **feature-parity ideas** (skills,
    schedules, approve-before-major-action UX).
- **Sources:** [gemini.google overview](https://gemini.google/overview/agent/spark/) ·
  [Google support](https://support.google.com/gemini/answer/17094507)

---

## Group B — Locked-down platforms (unofficial access)

Common pattern: the org disables formal apps/bots, so options narrow to (1) an
official API the *user* can still self-authorize, (2) undocumented internal
endpoints with a borrowed session token, or (3) **headless browser automation**
logged in as the user. (2)/(3) carry ToS + detection risk — capture explicitly.

### MS Teams
- **Goal:** check for new messages / mentions when formal integration is disabled.
- **Sanctioned (often blocked):** Microsoft **Graph API** — needs Azure AD app +
  **admin consent**, which is exactly what's disabled.
- **Unofficial:**
  - **Browser automation** (Playwright/Chromium) against `teams.microsoft.com` with
    a persisted authenticated session; poll for unread/mentions.
  - Reverse-engineered internal endpoints + a captured bearer token (fragile).
- **Feasibility (initial read):** **Low–Medium.** The blockers are **MFA +
  Conditional Access** on login and brittle DOM. Persisting a session past CA
  policies is the crux.
- **Risks:** ToS; account/conditional-access flags; fragile UI; corporate security
  optics.
- **Research tasks:**
  - [research] Can a Playwright session survive CA/MFA via a one-time manual
    bootstrap + cookie persistence?
  - [research] Stable signals for "new message" (DOM badge vs. internal API).

### Slack
- **Goal:** check for new messages/mentions when the workspace blocks apps.
- **Sanctioned (often blocked):** Slack **Web API** — needs a workspace-approved
  app/token.
- **Unofficial:**
  - **`xoxc` user token + `d` cookie** technique (the web client's own creds) to
    call internal APIs — generally **more robust than DOM scraping**.
  - Playwright against `app.slack.com` as a fallback.
- **Feasibility (initial read):** **Medium** (the token+cookie route is well-trodden).
- **Risks:** ToS (user-token automation); token/cookie expiry + refresh; detection.
- **Research tasks:**
  - [research] Validate the `xoxc`/`xoxd` flow + how long creds persist; refresh story.
  - [research] `conversations.history`/`search` reachability with a user token.

### Canvas (Instructure LMS)
- **Goal:** check new messages/announcements **and assignments/due dates**.
- **Sanctioned (maybe NOT blocked!):** Canvas **REST API** with a **personal access
  token** — at many institutions **students can self-generate** one without admin,
  so this may be a *legitimate* path. Endpoints for courses, announcements,
  assignments, calendar. Also **ICS calendar feeds** for assignment due dates.
- **Unofficial:** Playwright against the Canvas web app if tokens are disabled.
- **Feasibility (initial read):** **Medium-High** — likely the *least* hacky of
  Group B; check the institution's token policy first.
- **Risks:** institution may disable personal tokens; per-institution API quirks.
- **Research tasks:**
  - [research] Does the target institution allow personal access tokens?
  - [research] Map endpoints: announcements + `assignments` + the ICS feed for due
    dates. Polling cadence.

---

## Cross-cutting concerns

These apply across Group B (and parts of A); worth designing **once** as shared
substrate rather than per-integration.

- **[idea] Shared browser-automation substrate.** Teams/Slack/Canvas-fallback all
  want the same thing: a persistent, authenticated **headless Chromium session per
  account** (Playwright), cookie/token persistence, and a polling+diff loop for
  "what's new." Build it once; each platform is a thin adapter.
- **[research] Auth bootstrap + MFA.** Most realistic pattern: a **one-time manual
  interactive login** (human solves MFA) → persist the session → refresh headlessly
  until it dies → re-prompt. Design the re-auth UX.
- **[research] Change detection / triggers.** Polling cadence, dedup, "since last
  seen" cursors, and how new items surface (Discord notification? digest?).
- **[research] ToS / legal / detection.** Per platform: is this acceptable use for
  *your own* account? Ban/lockout risk. Document the call per integration.
- **[idea] Where it runs.** A headless-browser farm is heavy and stateful — a
  natural fit to run on a **`seam-bridge` machine** rather than the main host. See
  [seam-bridge-plan.md](./seam-bridge-plan.md) §8. The two roadmaps compose.
- **[idea] Packaging.** Each integration as a **standardized skill** with a common
  shape (auth, list-new, fetch, optional send/act) so any agent can call them.

## Quick triage (initial gut-feel — verify)

| Integration | Sanctioned path? | Initial feasibility | Notes |
|---|---|---|---|
| Gmail | ✅ strong (API/MCP) | **High** | Start here; MCP may be free win |
| Google Drive/Docs | ✅ strong (API/MCP) | **High** | Shares Google auth w/ Gmail; MCP present |
| Discord retrieval | ✅ bot-scope | **High** (bot) | User-scope = ToS no-go |
| Canvas | ✅ maybe (personal token + ICS) | **Med-High** | Check institution policy |
| Slack | ⚠️ blocked → `xoxc` token | **Medium** | Token+cookie > DOM scrape |
| Google Home | ⚠️ weak server APIs | **Med-Low** | Home Assistant as bridge? |
| MS Teams | ❌ blocked → browser | **Low-Med** | MFA/Conditional Access is the wall |
| Gemini Spark | ❌ no public API | **Not integrable now** | Google's own cloud agent (on Antigravity); watch for an API |

---

## Next actions
- [x] ~~Clarify "Gemini Spark"~~ → resolved: Google's own cloud agent, **no public
  API**; demoted to landscape/watch.
- [ ] Pick the **first spike** (suggest: Gmail via existing MCP — fastest signal).
- [ ] Decide if the **browser substrate** is worth building before any of Group B.
- [ ] Confirm Canvas **personal-token** availability at the target institution.
