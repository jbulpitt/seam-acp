# Service-status fixtures (#182)

Every fixture here is either a **recording** of a live upstream response captured
on 2026-09-03, or a **derived case** built from one of those recordings to
exercise a path the live payload did not exhibit at capture time. Derived files
are named `case-*.…` so the distinction never has to be guessed.

Recordings are trimmed (fewer incidents, clipped update bodies) and, where
noted, have insignificant whitespace normalized, but their field shapes, key
names, orderings and value vocabularies are exactly what the wire returned.
Nothing here was written from memory of what a vendor "should" send — green
tests over invented payloads are what sank the previous attempt.

## Recordings

- `statuspage/github-summary.json`, `statuspage/github-incidents.json` —
  `www.githubstatus.com/api/v2/…`. All twelve components, three incidents.
- `statuspage/anthropic-summary.json`, `statuspage/anthropic-incidents.json` —
  `status.claude.com/api/v2/…`.
- `statuspage/openai-summary-no-incidents.json` — `status.openai.com/api/v2/summary.json`
  **verbatim**, including the fact that it has no `incidents` and no
  `scheduled_maintenances` key, and that its components omit `group`,
  `group_id`, `description` and `only_show_if_degraded`.
- `statuspage/openai-incidents.json` — the matching history feed. Its incidents
  carry no `components` key and its updates carry no `affected_components`.
- `statuspage/grouped-active-summary.json` — `www.cloudflarestatus.com/api/v2/summary.json`,
  trimmed. GitHub, Anthropic and OpenAI all published flat, fully operational
  component lists at capture time, so this page is the recording that carries
  the Statuspage features they did not: component **groups** with children, a
  non-`none` page indicator, `under_maintenance` / `partial_outage` /
  `degraded_performance` component states, and genuinely **active** incidents
  (`monitoring`, `identified`).
- `xai/feed-live.xml` — `status.x.ai/feed.xml`, four real items. Between them
  they cover an explicit `Resolved:` line, updates listed newest-first, updates
  listed oldest-first, a resolved item with **no** `Resolved:` line at all, and
  a 109-day-long incident whose resolution time precedes its last update.

  The live feed pads the blank lines inside each `<description>` CDATA with
  spaces. **That trailing whitespace was normalized to empty lines here**, so
  this file is not byte-for-byte identical to the wire. Every semantic byte —
  tags, attributes, text, ids and timestamps — is verbatim; only insignificant
  inter-element whitespace differs, and the parser is whitespace-insensitive
  between blocks.
- `google-cloud/products.json`, `google-cloud/incidents.json` —
  `status.cloud.google.com/…`. The products list is trimmed to twelve real
  entries — every id the incident fixture references, plus the two Seam is
  configured to watch — including `Vertex Gemini API`, whose `current_title` is
  now `Gemini on Agent Platform` under an unchanged id. The incidents include
  one that affects a configured product and one that does not, and their
  updates are in the live newest-first order with `AVAILABLE` as the terminal
  status.
- `google-ai-studio/alkali-history.json` — the `ListIncidentsHistory` RPC
  response, including the `1 → 5 → 4` lifecycle sequence.
- `google-ai-studio/bootstrap.html` — a **sanitized** slice of
  `aistudio.google.com/status`. The two real `AIza…` API-key candidates were
  replaced with `AIzaSyFIXTURE…` placeholders of identical length; no real
  credential is committed.
- `linkworks/live.html` — `ollama.linkworksinc.com/live`, sanitized. The kept
  markup is the server-rendered `role="table"` block the adapter parses (not
  the Astro island's hydration `props`, which is an implementation detail); the
  island's `props` value is elided and private LAN host octets were rewritten
  `192.168.8.x` → `10.0.0.x`.

## Derived cases

- `statuspage/case-page-id-mismatch-incidents.json` — a history feed whose
  `page.id` belongs to a different page.
- `statuspage/case-crossed-feeds-summary.json` + `…-history.json` — the same
  incident id in both feeds: **active** and older in the summary, **resolved**
  and newer in the history. The history record must win regardless of read
  order. The history copy also contains two updates sharing one `display_at`,
  listed in reverse id order, to pin tie-breaking.
- `xai/case-active.xml` — an unresolved item with two updates.
- `xai/case-ambiguous-lifecycle.xml` — `Status: RESOLVED` contradicted by the
  item's own category tags.
- `xai/case-malformed-date.xml` — an update timestamp that is not a date.
- `google-ai-studio/case-active.json` — an incident whose newest update is
  lifecycle code 5, so it is unresolved.
- `google-ai-studio/case-unknown-code.json` — lifecycle code 9, outside the
  observed 1–5 range.
- `google-ai-studio/case-duplicate-terminal-update.json` — the same terminal
  code-4 update posted twice, byte for byte, so the newest update only keeps
  its lifecycle code if the code travels with it through uniquifying.
- `google-cloud/case-active-gemini.json` — an open incident (`end: null`, no
  terminal `AVAILABLE`) against a configured product.
- `google-cloud/case-unknown-product-id.json` — an incident naming a product id
  the catalogue does not list, which must fail the whole refresh rather than be
  quietly skipped.
- `linkworks/case-unknown-status.html` — an unrecognized status pill word.
