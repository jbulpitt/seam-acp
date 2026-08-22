# Interactive prompts (frozen choice cards)

Canonical **agent** how-to for frozen choice cards and HTTP ingest. The Discord
preamble and MCP tool blurbs stay one-liners; **this file is the spec**. Do not
wait for the harness to teach you the protocol.

Consuming projects (school course repos, etc.) pin the **raw GitHub URL** in
their context library:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md`

Pin to a tag or commit SHA if a class must not drift with `main`. The project’s
own doc only overlays **this course** (where attempts land, which tokens exist).
Do not fork the protocol.

## What it is

A **frozen click-card** in Discord. Buttons (or a select) whose click emits
**one** prompt the bridge already knows how to deliver. Labels, payloads, and
destinations cannot change after publish. Cancel is the only mutation.

Publish with:

- MCP `create_choice({ title, options, … })` → `{ choiceId, messageId }`
- or a fenced block tagged `seam-choice` whose body is the same JSON

The fence is stripped from chat; the card is a follow-up message in **this**
thread.

## JSON

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
      "payload": "Approved. Merge and redeploy.",
      "target": { "type": "live" }
    },
    {
      "label": "Send to QA",
      "kind": "prompt",
      "payload": "QA this branch. Report back.",
      "target": { "type": "thread", "threadId": "1538553006801551370" }
    },
    {
      "label": "Type a fix…",
      "kind": "custom",
      "target": { "type": "isolated" }
    }
  ]
}
```

- `title` required, ≤256. `options` 1–25 (≤24 if any option is `custom`).
- `kind: "prompt"` requires a non-empty `payload`. `kind: "custom"` ignores
  payload; the typed modal text **is** the payload (≤4000).
- `target` omitted → `defaultTarget` → `{ "type": "live" }`.
- `maxClicks` default 1, cap 100. Always **one successful click per Discord user**.
- `targetUserId` (snowflake): only that user may click.

## Destinations

- **`live`** — this card’s Discord thread, persistent session. Queues behind a
  busy turn; does not abort it.
- **`isolated`** — throwaway ACP session. Output posts in the **card’s**
  Discord thread. Inherits the authoring thread’s agent/model/cwd. No new
  Discord thread. Does not appear in `/seam sessions`.
- **`thread`** — another seam thread by snowflake (`threads()`). Always **live**
  there. Unknown/gone/archived → click is **not** consumed.

Do not use `parked_prompts` for this. Delivery is `enqueueDispatchSpec`.

## Who may click / who may author

- Click: anyone in `DISCORD_ALLOWED_USER_IDS` (includes restricted
  participants), unless `targetUserId` is set.
- Author / cancel: **not** restricted participants. Injected turns
  (dispatch, isolated, wake, watch) may author. Gate uses the Discord
  **author id** of the user turn, independent of `SPEAKER_IDENTITY_ENABLED`.
- Cancel: MCP `cancel_choice({ choiceId })` or `/seam workflows cancel-choice:<id>`.

## Click lifetime

No TTL. Durable across redeploy (persistent `custom_id`s, not collectors).
Exhausted or cancelled: buttons disabled; footer shows `clicked/max`.

## Emitted prompt

The bridge wraps provenance the model did not write:

```
<seam-choice>
Card <id> option "<label>" clicked by <name> (id <snowflake>).
Authoring thread: <channelRef>. Destination: live|isolated|thread <id>.
</seam-choice>

<payload or typed custom text>
```

## HTTP ingest (#92)

Same frozen table. A microsite `POST /ingest` is a **custom-option submit**.
The HTTP body is **not** the Discord transcript. The scoring turn must
**declare** a result.

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
token in the public page source if you can avoid it; a tiny backend or
build-time inject is fine. `ingress: true` is enough if you want defaults
(first custom option, no schema, any CORS origin).

A `seam-choice` fence does **not** mint an ingest token (it would leak in
the thread). Use MCP `create_choice` for HTTP ingest.

When `ingress` is set and `maxClicks` is omitted, the cap is 100 (class-sized),
not 1.

### POST

```
POST {ingestUrl}
Authorization: Bearer {ingestToken}
Content-Type: application/json

{ "text": "student essay…", "studentId": "optional-untrusted-label" }
```

Also accepts `application/x-www-form-urlencoded`. `studentId` is **never
trusted** as identity; the bridge stamps provenance. Same student id cannot
submit twice on the same card (`already-clicked`). Targeting is the frozen
option’s `live` | `isolated` | `thread`. Queue, don’t abort.

Auth is the site token, **not** a seam-MCP session token, **not** `/mcp`.

### Declared result (required)

The HTTP caller does **not** get your Discord transcript. If you do not declare
a result, the site gets an error (`504` / job `missing`).

In the ingest-triggered turn, do this **before** you stop:

1. MCP `submit_result({ overallScore: 3, prose: "…" })` — the arguments object
   **is** the HTTP body. First successful call wins.
2. If you have no MCP (agy, etc.), output a fenced block tagged `seam-result`
   whose body is the same JSON (stripped from Discord). Isolated turns still
   harvest that fence from captured text.

If `resultSchema` was frozen at publish, the object is validated; a mismatch
is rejected so you can retry in-turn. Match the schema the **authoring** agent
chose (`overallScore`, `improvementFactor`, `prose`, …). Seam does not invent
those fields.

Turn ends with no result → HTTP error / timeout. **No transcript fallback.**

Prefer `defaultTarget: { "type": "live" }` for school microsites so the course
thread sees the working **and** MCP `submit_result` is definitely present.
`isolated` is allowed; it reuses the authoring thread’s MCP token.

POST holds for `SEAM_INGEST_WAIT_MS` (default **5 minutes**, ceiling 30) waiting
on `submit_result`, then returns `202 { jobId, poll }`. The site
`GET /ingest/jobs/{jobId}` with the same Bearer until `200` or `504`.

Long grading is normal — **poll is the long path**, not a fatter POST.
Cloudflare proxied hosts (`ingest.runbooksynthesis.com`) kill idle POST at
~100s (`524`) *before* a 5-minute wait can return, and that 524 has **no
jobId**. For a public microsite: `POST /ingest?wait=0` (202 immediately with
`jobId`) then poll. Direct/loopback can sit on the POST.

Discord still gets whatever else you wrote (`live` / `thread` = teacher
working). Isolated may be quiet except an optional breadcrumb.

### Persist

There is no LMS store. If the wrapper says to write the attempt into the
project cwd, do that with file tools so a later session can read it.
