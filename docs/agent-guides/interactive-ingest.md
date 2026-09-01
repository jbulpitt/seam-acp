# HTTP ingest for agents

Canonical agent guide for accepting HTTP submissions through Seam. When the
task is only an in-thread human choice, read instead:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md`

Consuming projects pin this raw URL:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-ingest.md`

There are two products:

- **Card-bound ingest** adds an HTTP submit door to a frozen Discord choice
  card. Use it when the card and its thread are part of the workflow.
- **Headless ingest** is a reusable HTTP contract with no Discord card. Use it
  for microsites, quizzes, and refine loops.

Both accept the same POST body and require the scoring agent to declare JSON
with `submit_result`. The HTTP body is not a Discord transcript.

## Card-bound ingest

Set `ingress` on MCP `create_choice`. A `seam-choice` fence cannot mint a token.
When `ingress` is set and `maxClicks` is omitted, the card defaults to 100
claims.

```json
{
  "title": "Essay check",
  "maxClicks": 100,
  "defaultTarget": { "type": "live" },
  "options": [
    { "label": "Submit…", "kind": "custom" }
  ],
  "ingress": {
    "optionIndex": 0,
    "wrapper": "Grade against the rubric. Persist under submissions/. Then call submit_result matching the schema.",
    "resultSchema": {
      "type": "object",
      "required": ["overallScore", "prose"],
      "properties": {
        "overallScore": { "type": "number" },
        "prose": { "type": "string" }
      }
    },
    "corsOrigins": ["https://course.example.edu"]
  }
}
```

`create_choice` returns `ingestUrl` and `ingestToken` once. Prefer a `live`
target when the course thread should see the work. A repeated `studentId` is
refused for card ingest.

## Headless ingest

Mint with MCP `create_ingest` only. It creates no hidden card and normally posts
nothing to Discord. Scoring runs in a silent isolated session; retries are
unlimited unless `uniqueStudent: true`. Set `notifyThread` only when Discord
should receive a copy of the work.

```json
{
  "name": "hist2300-essay-check",
  "preset": "hist-grader",
  "wrapper": "Grade this. Persist under submissions/. Then call submit_result matching the schema.",
  "resultSchema": {
    "type": "object",
    "required": ["overallScore", "prose"],
    "properties": {
      "overallScore": { "type": "number" },
      "prose": { "type": "string" }
    }
  },
  "uniqueStudent": false
}
```

It returns `{ ingestId, ingestUrl, ingestToken }`. Revoke new submissions with
`cancel_ingest({ ingestId })`; in-flight jobs finish.

### Choose the scoring agent

The POST never selects an agent or model. At mint time choose one of:

- **`preset`** (preferred for a named grader). It is resolved in the minting
  thread's project scope and re-resolved on every POST, so preset edits apply
  without reminting. It cannot be combined with `agent`, `model`, `effort`, or
  `cwd`. Cross-channel preset names use `<parent-channel-snowflake>/<name>`.
- Pin `agent`, `model`, `effort`, and/or `cwd` on the endpoint.
- Omit both to inherit the minting thread's runtime settings.

Keep the **assignment contract**—rubric, persistence path, and result shape—in
`wrapper`. Keep the reusable **grader identity** in the preset.

## POST and poll

```text
POST {ingestUrl}
Authorization: Bearer {ingestToken}
Content-Type: application/json

{ "text": "student essay…", "studentId": "optional-untrusted-label" }
```

Form-encoded bodies are also accepted. `studentId` is an untrusted label.

The public host is `https://ingest.runbooksynthesis.com/ingest`. Public clients
should use `POST /ingest?wait=0`, receive `{ jobId, poll }`, then poll
`GET /ingest/jobs/{jobId}` with the same Bearer token. A held public POST may be
cut off by Cloudflare before Seam's own wait ceiling.

The token is shown once. Inject it server-side or at build time; do not ship it
in public client-side JavaScript when a small backend can hold it.

## Declared result and persistence

The scoring turn must call `submit_result({ ... })` before ending. The first
successful call wins, and an optional `resultSchema` is enforced in-turn. If the
turn ends without a declared result, the HTTP job fails; there is no transcript
fallback.

Seam is not an LMS or submission store. Persist attempts in the endpoint's
project cwd exactly as the wrapper instructs.
