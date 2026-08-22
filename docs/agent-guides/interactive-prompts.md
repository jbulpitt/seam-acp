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
build-workflow check-ins. Cross-thread routing, isolated runs, and HTTP
ingest are later in this file — skip them until you need them.

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
click** — a class quiz, a stand-up vote, HTTP ingest for many students.
Then buttons **stay** until the cap; footer is `clicked/max`. One click per
Discord user even then.

If you are not sure, leave `maxClicks` off.

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

## HTTP ingest (microsites)

Same frozen table. A microsite `POST /ingest` is a **custom-option submit**.
The HTTP body is **not** the Discord transcript. The scoring turn must
**declare** a result.

This is multi-user by default: when `ingress` is set and `maxClicks` is
omitted, the cap is 100.

### Publish with ingress

```json
{
  "title": "Essay check",
  "maxClicks": 100,
  "defaultTarget": { "type": "live" },
  "options": [
    { "label": "Submit…", "kind": "custom", "target": { "type": "live" } }
  ],
  "ingress": {
    "optionIndex": 0,
    "wrapper": "Grade this essay against the rubric. Persist the attempt under submissions/. Then submit_result matching the schema.",
    "resultSchema": {
      "type": "object",
      "required": ["overallScore", "prose"],
      "properties": {
        "overallScore": { "type": "number" },
        "improvementFactor": { "type": "string" },
        "prose": { "type": "string" }
      }
    },
    "corsOrigins": ["https://course.example.edu"]
  }
}
```

`create_choice` returns `ingestUrl` + `ingestToken` **once**. Do not put the
token in a public page if you can inject at build/serve time. `ingress: true`
uses defaults (first custom option, no schema).

A `seam-choice` fence does **not** mint an ingest token. Use MCP
`create_choice` for HTTP ingest.

### POST

```
POST {ingestUrl}
Authorization: Bearer {ingestToken}
Content-Type: application/json

{ "text": "student essay…", "studentId": "optional-untrusted-label" }
```

Also `application/x-www-form-urlencoded`. `studentId` is untrusted. Same id
cannot submit twice. Prefer `live` so the course thread sees the working.

Public host: `https://ingest.runbooksynthesis.com/ingest`.

### Declared result (required)

Call `submit_result({ overallScore: 3, prose: "…" })` before you stop, or a
`seam-result` fence. First success wins. Schema mismatch is refused in-turn.

Turn ends with no result → HTTP error. **No transcript fallback.**

POST holds `SEAM_INGEST_WAIT_MS` (default **5 minutes**, ceiling 30) then
`202 { jobId, poll }`. `GET /ingest/jobs/{jobId}` with the same Bearer.

Cloudflare kills held POST at ~100s (`524`) with **no jobId**. Public
microsites: `POST /ingest?wait=0` then poll.

### Persist

No LMS store. Write attempts into the project cwd as the wrapper says.
