# LLM Industry Watch — Runbook

> **Purpose:** A discovery-first industry digest. Enthusiasm, capability, new
> models, leaks, timing, lab shakeups, open-weight shocks. **Not** seam-acp
> impact, CLI changelogs, or status pages.
>
> **Cadence:** Daily (America/Chicago). Every fire updates the notebook.
> **Wed and Sat** posts are a weekly recap (repeating major headlines is
> expected). Other days are movers-only; if nothing cleared the bar, the
> Discord message is a single "no movers" line.
>
> **Product:** `digest.md` is the notebook you reread. The agent's **final
> message** is a short Discord newsletter posted to thread
> `1545798016601034883`.
>
> **Last updated:** 2026-09-05 (daily + Wed/Sat recap)

---

## 0. Cold start

You are a fresh session. You have **no memory** except the files in this
directory. Read them before searching:

1. This runbook.
2. [`digest.md`](digest.md) — living notebook (may be empty).
3. [`storylines.md`](storylines.md) — topic tracking after discovery (may have
   no live rows).
4. The latest file in [`snapshots/`](snapshots/) if any — last AA numbers.
5. The latest file in [`log/`](log/) if any — last sweep receipts.

**Do not** read or edit `docs/upstream-monitoring-runbook.md`. That is a
different job (tool changelogs → code impact).

**Do not** seed or revive Jesse's example headlines as storylines unless this
sweep independently found them. Those examples live only in Appendix A as a
retroactive inclusion test.

**Environment:** Prefer Grok (native X search). If you have no X tools, use
web search and `site:x.com` plus named handles. Use Seam MCP
`model_metadata_query` / `model_metadata_get` for Artificial Analysis numbers
(cached; do not treat missing AA coverage as "the model does not exist").
If you are `agy` on this Discord bridge, **do not spawn subagents** — they
are killed when the turn ends. Work inline.

**Write scope:** only `docs/industry-watch/**`. Commit those files. Do not
redeploy. Do not touch other docs or source.

---

## 1. What this is / is not

**In:** unreleased-model speech, roadmap cancel/restart/delay/rename, government
or policy constraint on a lab's best models, release phasing and access gating,
open-weight approaching or beating closed frontier, first serious public
benchmark of a previously rumored model, training-run / cluster / capital
signals that imply a frontier attempt, named flagship talent leaving to found
something, non-flagship labs appearing via artifacts (HF, AA new row, Arena).

**Out:** seam-acp impact, CLI versions, status pages, product-UI trivia,
unsourced "reports suggest", last week's rumor restated as news with no
status/confidence change, vendor blog framing as the headline.

**Anti-spin / clustering:** official memos are a source, never the headline.
Same-week leadership change + missing flagship + rank drop + named researchers
leaving = **one** story ("lab in crisis / restart"), not three happy items.
Absence is evidence (promised model still missing, Arena sighting yanked,
Flash-only cadence). Quote executives verbatim; never turn "soon" into a date.

---

## 2. Files (this is memory)

- `runbook.md` — process. Edit only when a sensor or rule was wrong.
- `digest.md` — living notebook. Rewrite in place each sweep.
- `storylines.md` — persistent topics **after** discovery. Empty until a sweep creates rows.
- `snapshots/YYYY-MM-DD.md` — AA top-N for numeric diff against yesterday.
- `log/YYYY-MM-DD.md` — receipts: what was checked, including silence.

Today's date for filenames: the sweep's local date in America/Chicago
(`YYYY-MM-DD`). Weekday for Discord mode is also America/Chicago.

---

## 3. Sweep procedure

### Phase A — Load state

Read the files in §0. Note `last_sweep` from digest front matter (or "never").
Decide **Discord mode** from today's America/Chicago weekday:

- **Wed or Sat → `recap`.** Discord post is a weekly summary of the last 7
  days. Repeating major headlines already posted on a daily brief is
  required, not a defect.
- **Any other day → `daily`.** Discord post is only what moved **since
  last_sweep**. If nothing cleared §4, the final message is one "no movers"
  line (see §7). Never pad with a 🤫 Quiet list on a daily fire.

All searches are **since last_sweep**, except a first run which uses the past
~14 days. Recap days still search since last_sweep for discovery; the
**Discord recap** additionally rereads `digest.md`, `storylines.md`, and
the last 7 logs/snapshots so headlines from earlier in the week can be
repeated.

### Phase B — Numbers (AA as an event feed)

Call `model_metadata_query` with `hasBenchmark: true`, sort by benchmark
desc, limit 15–25. Also query recently released names (`releasedAfter` ≈ 60
days) and `nameContains` for creators **not** on the storyline list.

Write `snapshots/YYYY-MM-DD.md` with Intelligence Index (and Coding if
present) for the top ~12 plus any new name. Diff against the previous
snapshot.

**AA news is only:** a new row, a first score for a rumored model, a move of
≥1.0 Intelligence Index, a new name in the top 10, an open-weight model
within ~5 points of the closed leader. AA will not cover unbenchmarked
rumors — that is the qualitative half. Do not look up a leaked name on AA
and conclude it is fake because it is absent.

### Phase C — Revisit open storylines

For every **live** row in `storylines.md`, run its **canned queries** (the
`search` field). Update `last_checked`. If something moved, update status,
confidence, latest bullets, sources, `last_movement`. If nothing moved, write
`no new signal` in the log — do not delete the row. After **14** consecutive
quiet daily sweeps (~two weeks), set status to `stale` (keep the row). Do
not use a 3-sweep stale rule — that was for weekly cadence.

### Phase D — Nameless discovery (the point of the product)

Run these sensors **without** requiring a company to already be on the list.
Promote a new org/person onto `storylines.md` only if at least one inclusion
bar in §4 is true.

**People (X first, web second).** Check named researchers and founders for
founding posts, departures, timing claims, cancellations. Minimum handles to
try (add new ones to this list when they clear the bar — that is self-update):

- xAI / Grok: `elonmusk`, `xai`, `grok`
- OpenAI: `sama`, `OpenAI`
- Anthropic: `AnthropicAI`, `darioamodei`
- Google / DeepMind: `JeffDean`, `demishassabis`, `GoogleDeepMind`, `sundarpichai`
- Meta: `ylecun`
- Open-weight / non-flagship: `Kimi_Moonshot`, `Zai_org` / Zhipu, DeepSeek,
  Qwen / Alibaba, Mistral
- Analysts who unspin labs: `SemiAnalysis_`, `natolambert`

**Talent-flow queries** (no new company name required):

- `"leaves" (DeepMind OR OpenAI OR Anthropic OR Google OR Meta) (found OR founding OR startup)`
- `"chief scientist" (resigns OR departing OR leaving)`
- `"we are founding"` AI

**Artifact surfaces** (how Moonshot / Zhipu show up before Western blogs):

- Hugging Face trending / new orgs with large or sudden models
- AA newly added creators not on `storylines.md`
- LM Arena: a model appearing then vanishing
- Epoch AI (free) if a claimed pretrain needs a compute sanity check

**Free journalism that restates paid scoops** (secondary; cluster, do not
headline the outlet): Reuters, Axios, Verge, Fortune, Guardian, The Decoder,
Wired when unpaywalled, OfficeChai-style recaps of SemiAnalysis. Use them to
catch The Information / SemiAnalysis facts 1–3 days late. **No paid
subscriptions are required.**

**Official blogs** last, and only as the thing to distrust and cluster
against (blog.google, OpenAI, Anthropic news).

### Phase E — Rewrite the notebook

Update `digest.md` to the current picture (template in §6). Archive resolved
storylines to a `## Resolved` section at the bottom of `storylines.md` (keep
short). Hard cap: digest stays rereadable in one sitting (~2–4 screens).

Write `log/YYYY-MM-DD.md` with: sensors checked, storylines revisited,
new rows created, AA movers, **silence** (checked, nothing).

Commit **only** `docs/industry-watch/` (`git add` those paths, commit).
Message: `docs(industry-watch): sweep YYYY-MM-DD`. Do not `git add -A`.
Do not include `docs/upstream-monitoring-runbook.md`. Do not redeploy.
Push if you have network and it is cheap; host disk is what the next fire reads.

### Phase F — Discord newsletter (your final message)

The scheduled runner **captures your last assistant message** and posts it
to Discord thread `1545798016601034883` (via the schedule's Output id, or
because the schedule is bound there).

**That final message must be only the newsletter.** No chain-of-thought, no
"I committed…", no file paths dump, no MCP narration. Work log belongs in
`log/YYYY-MM-DD.md`.

Follow §7 for the mode chosen in Phase A (`daily` vs `recap`). Aim for
**≤1900 characters** so Discord keeps it as **one plain message** (the
runner splits at 1900 chars with no regard for words). Recap days should
still fit in one message; cut Quiet and extra links first, not Movers.

Do **not** try to emit Discord embed JSON, `seam-choice` cards, or custom
rich embeds. Do **not** `forward` / `handoff` / `send` the digest into the
News thread — that starts or inboxes another agent. The schedule's
`targetChannel` + `outputType: messages` is the delivery path.

If you are running this **manually** (not a scheduled fire), still make the
final message the newsletter; it will land in the thread you are in. Prefer
a scheduled fire so delivery hits `1545798016601034883`.

---

## 4. Inclusion bar (unknown names)

Create or keep a storyline only if at least one is true:

- Named flagship talent is involved (departure, founding, public dissent).
- Credible claim they are training or releasing something frontier-scale.
- An open-weight drop that moves a public bench, or a first AA score.
- Capital / compute that implies a real training attempt (hyperscaler cloud
  deal, cluster rumor from a named source) — not a wrapper startup.
- Government / policy action on a lab's best models.
- A roadmap cancel, restart, or silent non-ship of a promised flagship.

A random YC chatbot wrapper is out. A four-person DeepMind spinout with no
model yet is in **if** the talent + capital bar hits — as a symptom of the
lab they left, not as a separate happy startup story, until proven otherwise.

---

## 5. Storyline schema

Each live row in `storylines.md`:

```
### `id-slug`
- **title:**
- **status:** rumored | training | delayed | cancelled | shipping | GA | stale
- **confidence:** confirmed | credible | speculative | contradicted
- **last_movement:** YYYY-MM-DD
- **last_checked:** YYYY-MM-DD
- **quiet_sweeps:** 0   (stale at 14)
- **expected_window:** (quote or "unspecified" — do not invent dates)
- **why_it_matters:** one line
- **latest:** 2–4 bullets; execs in verbatim quotes
- **search:** handles and query strings the next sweep must reuse
- **sources:** `- YYYY-MM-DD · kind · URL` where kind is
  official | exec-x | journalist | leak | benchmark | artifact
- **open_questions:**
```

`kind` on sources is load-bearing. Do not promote speculative → confirmed
without a primary source.

---

## 6. `digest.md` template

```
# LLM Industry Watch

- **last_sweep:** YYYY-MM-DD
- **one_line:** (current picture in one sentence)

## Frontier snapshot
Closed vs open-weight gap on AA Intelligence Index. Only movers and new
names, plus the current top 5–8. Link slugs if useful.

## Live storylines
One short subsection per live row (status + latest). No process talk.

## New this sweep
Names that were not on the list yesterday (or last recap, if writing the
Wed/Sat notebook view), and why they cleared §4.

## Calendar / expected
Quoted windows only.

## Quiet
Storylines checked with no movement (one line each).
```

---

## 7. Discord newsletter format

Plain Discord markdown. Emoji as section marks. **No tables** (they wrap and
break). No `#` heading spam — Discord treats `#` as a channel mention. Use
`**bold**` lines instead of `##`. Stay ≤1900 characters.

Confidence tags: `✅ confirmed` `🟡 credible` `🟣 speculative` `⚔️ contradicted`.
Links sparingly (`[source](https://...)`) — one on the headline item, not a
bibliography.

### 7.1 Daily brief (Sun, Mon, Tue, Thu, Fri)

Only what moved since `last_sweep`. Delete empty sections. **If nothing
cleared §4 and AA had no shock,** the entire final message is exactly:

```
📡 **LLM Industry Watch** · 6 Sep 2026 — no movers.
```

Do not add Quiet, Leaderboard-of-unchanged, or "checked N sources." An empty
assistant message becomes a useless "✅ Done — no output" card; the one-liner
is the skip signal.

Movers-day skeleton:

```
📡 **LLM Industry Watch** · 6 Sep 2026

🔥 **Today**
• **Name** — what changed, how sure
• **Name** — …

🆕 **New**
• **Name** — why it cleared the bar

📊 **Leaderboard**  (omit if no shock)
• only deltas
```

### 7.2 Weekly recap (Wed and Sat)

Cover the last 7 days. **Repeating major headlines from daily briefs is
required.** This is the rereadable post, not a delta. Cluster (one lab
crisis, not three items). Omit Quiet if you need the character budget.

```
📡 **LLM Industry Watch** · weekly recap · 9 Sep 2026

**This week:** <one sentence>

🔥 **Headlines**
• **Name** — the week's arc (ok if posted Mon/Tue already)
• **Name** — …

🧭 **Storylines**
• **slug** — where it stands now

🆕 **New on the board**
• **Name** — why it cleared the bar

📊 **Leaderboard**
• closed vs open-weight gap + shocks this week

—
Notebook: `docs/industry-watch/digest.md`
```

---

## 8. Self-update this runbook

After a sweep, if a sensor missed something that later showed up, or a new
handle/query earned its place, edit **this file** (add the sensor or handle,
not the headline). If Appendix A would have failed, the process is too thin.

Do not add today's stories to Appendix A as if they were eternal. Appendix A
is a historical test, frozen except to add a *class* of miss ("we missed a
non-US lab until HF trending").

---

## Appendix A — Retroactive inclusion test (not seed data)

If this process had been running, it should have caught these **classes**
without anyone listing the names. Do **not** copy them into `storylines.md`
unless this sweep found them again from sources.

- Exec speech about unreleased models and timing (e.g. Musk on next Grok).
- A flagship silently cancelled / restarted, hidden by Flash cadence and a
  "next chapter" memo (e.g. Gemini 3.5 Pro + Google leadership shuffle).
- Talent-exit as the press-release face of that failure (e.g. Discovery Loop
  / Dean–Vinyals leaving the same week) — cluster, do not celebrate the PBC.
- Government constraint on a lab's high-end models (e.g. Anthropic
  Mythos / Fable).
- Phased frontier releases (e.g. GPT-6 slices and access tiers).
- Open-weight labs you did not already follow, appearing via HF / AA / Arena
  (e.g. Kimi K3, GLM 5.3).

If a sweep would have filed Discovery Loop as "cool new science startup"
under Google's own framing, the sweep failed §1 clustering.
