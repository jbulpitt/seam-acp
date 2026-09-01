# Interactive prompts (frozen choice cards)

Canonical **agent** how-to. The Discord preamble and MCP blurbs stay one-liners;
**this file is the spec**. Do not wait for the harness to teach you.

Consuming projects pin this raw URL in their context library:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md`

Pin to a tag or commit SHA if a class must not drift with `main`. Overlay only
**this course** (persist paths, tokens). Do not fork the protocol.

---

## The basic use (do this first)

A choice card is a **structured question in the same live thread**: Approve /
Reject, pick a plan, pick a topic. Someone clicks; **this thread** gets one
prompt; the card **shows what they picked and the buttons go away**.

That is the default. Use it constantly for student feedback and for
build-workflow check-ins. Cross-thread routing and isolated runs are later in
this file; HTTP submissions have a separate guide. Skip them until needed.

Publish with MCP `create_choice` or a `seam-choice` fence (stripped from
chat; the card is a follow-up in **this** thread):

```json
{
  "title": "Does this explanation make sense?",
  "options": [
    { "label": "Yes — continue", "kind": "prompt", "payload": "Student said continue. Next topic." },
    { "label": "No — explain again", "kind": "prompt", "payload": "Student wants another explanation. Slow down." }
  ]
}
```

That is enough. `defaultTarget` is **live** (this thread). `maxClicks` is **1**
(single-user). After one click: selected label is on the card, components are
**removed**, not left disabled.

Custom (typed) option:

```json
{
  "title": "What should we try next?",
  "options": [
    { "label": "Quiz me", "kind": "prompt", "payload": "Give a short quiz on the last topic." },
    { "label": "Type a question…", "kind": "custom" }
  ]
}
```

`kind: "custom"` opens a modal. The typed text **is** the payload (≤4000).

---

## Single-user vs multi-user

**Default is single-user.** One person, one pick. `targetUserId` (restrict
*who* may click) does **not** change this — it is still one pick, then the
card closes visually.

- Normal card (almost always): omit `maxClicks` (1).
- Only one named person may click: set `targetUserId`, still omit `maxClicks`.
- Class / several teammates each pick: `maxClicks` > 1 (cap 100).

**Use multi-user only when several people should each submit a distinct
click** — for example a class quiz or stand-up vote.
Then buttons **stay** until the cap; footer is `clicked/max`. One click per
Discord user even then.

If you are not sure, leave `maxClicks` off.

---

## Multi-select (several options, one Confirm)

Set `select: { min?, max? }` to publish a **dropdown + Confirm** instead of
one-click buttons. The user ticks several options, clicks Confirm, and **one
combined prompt** is emitted. The card then shows `Selected: A, B, C` and the
components go away.

```json
{
  "title": "Which topics should we cover?",
  "select": { "min": 1, "max": 3 },
  "options": [
    { "label": "Loops", "kind": "prompt", "payload": "Cover loops next." },
    { "label": "Recursion", "kind": "prompt", "payload": "Cover recursion next." },
    { "label": "Testing", "kind": "prompt", "payload": "Cover testing next." }
  ]
}
```

- Omitted `min` is **1**. Omitted `max` is `options.length`. Both clamp to
  `[1, min(options.length, 25)]`. `min` must be ≤ `max`.
- **All options must be `kind:"prompt"`.** `select` + `custom` is rejected.
- **`select` + `maxClicks>1` is unsupported (v1)** and is rejected. Multi-select
  is still one person, one Confirm (default `maxClicks` 1).
- Destination is the card `defaultTarget`. Per-option `target` does not apply
  to a combined pick.
- Pending ticks are in-memory (reset on restart). The card itself survives
  restart as a multi-select.

Emitted body:

```
<seam-choice>
Card <id> options "Loops, Recursion" clicked by <name> (id <snowflake>).
Authoring thread: <channelRef>. Destination: live|isolated|thread <id>.
</seam-choice>

Selected: Loops, Recursion
Cover loops next.
Cover recursion next.
```

---

## JSON (full)

```json
{
  "title": "Ship this?",
  "body": "Optional text on the card. Not emitted.",
  "maxClicks": 1,
  "targetUserId": null,
  "defaultTarget": { "type": "live" },
  "options": [
    {
      "label": "Approve",
      "kind": "prompt",
      "payload": "Approved. Merge and redeploy."
    }
  ]
}
```

- `title` required, ≤256. `options` 1–25 (≤24 if any option is `custom`).
- `kind: "prompt"` requires non-empty `payload`. `kind: "custom"` ignores payload.
- `target` omitted → `defaultTarget` → `{ "type": "live" }`.
- `select: { min?, max? }` ⇒ multi-select dropdown + Confirm (see above). Cannot
  combine with `custom` or `maxClicks>1` (v1).

---

## Destinations (when you outgrow live-this-thread)

- **`live`** (default) — this card’s Discord thread. Queues behind a busy turn;
  does not abort it.
- **`isolated`** — throwaway ACP session. Output in the **card’s** thread.
  Inherits authoring agent/model/cwd. Not listed in `/seam sessions`.
- **`thread`** — another seam thread by snowflake (`threads()`). Always live
  there. Unknown/gone → click not consumed.

Do not use `parked_prompts` for this.

---

## Who may click / who may author

- Click: `DISCORD_ALLOWED_USER_IDS` (includes restricted participants), unless
  `targetUserId` is set.
- Author / cancel: **not** restricted participants. Injected turns may author.
- Cancel: MCP `cancel_choice({ choiceId })` or `/seam workflows cancel-choice:<id>`.

---

## Emitted prompt

```
<seam-choice>
Card <id> option "<label>" clicked by <name> (id <snowflake>).
Authoring thread: <channelRef>. Destination: live|isolated|thread <id>.
</seam-choice>

<payload or typed custom text>
```

---

## HTTP ingest is a separate workflow

If a microsite or service must submit work over HTTP, continue with the
canonical guide:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-ingest.md`

It covers both a choice card with an ingest token and a reusable headless
endpoint. Do not load that protocol for an ordinary in-thread decision.
