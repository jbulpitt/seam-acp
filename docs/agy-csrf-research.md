# AGY local CSRF authentication — research findings

*Received 2026-09-21. Independent research, reproduced against official Linux ARM64 binaries.
Preserved here because the source was a transient attachment. Not a Seam test result —
see "Evidence level" below before citing it as one.*

## Finding

Seam can choose a fresh token when launching AGY, pass it as the hidden
`--csrf_token=<token>` argument, and attach the same value in the
`x-codeium-csrf-token` header on requests to that child's language server.
It does **not** need to recover AGY's internally generated token from its sidecar.

Verified against official 1.2.2 and 1.2.7, and works on 1.1.27 and 1.2.0.

**This is an adapter fix path, not fleet upgrade approval.**

## What changed since the original diagnosis

The original investigation correctly identified mandatory local CSRF authentication and
correctly ruled out `ANTIGRAVITY_CSRF_TOKEN` on the parent-launched process. Its inference
that *no launch flag existed* was too strong: **the flag is accepted but omitted from
`--help`.**

Omnigent found the same thing independently on 2026-09-14; merged implementation in
omnigent-ai/omnigent#7200 (2026-09-16), with process-discovery optimisation in #7578.
The earlier #7389/#7395 route was superseded.

Google's latest release at time of research was **1.2.7 (2026-09-19)**, with no documented
CSRF fix in the inspected notes. **1.2.7 still rejects tokenless subscriptions — upgrading
alone does not repair Seam.**

## Authentication matrix — 36 requests, all expected assertions passed

Four versions x three launch modes x three header cases:

- **1.1.27 and 1.2.0, ordinary launch** — missing, arbitrary and env-selected headers all
  reach the missing-trajectory error. Authentication is not enforced by default on these.
- **1.2.2 and 1.2.7, ordinary launch** — no header gives `unauthenticated / missing CSRF
  token`; arbitrary header gives `invalid CSRF token`.
- **1.2.2 and 1.2.7, env-only token** — sending the `ANTIGRAVITY_CSRF_TOKEN` value still
  gives `invalid CSRF token`. Independently reproduces the earlier failed approach.
- **All four versions, `--csrf_token` launch** — absent header gives `missing`, wrong value
  gives `invalid`, matching header **passes** and reaches the expected missing-trajectory
  error.

Every response was HTTP 200; the meaningful result was in the Connect end-of-stream
envelope, not the status. The nonexistent trajectory is a control proving admission beyond
authentication — it is not a successful conversation.

**Compatibility caution:** 1.1.27 accepts the flag and *starts enforcing it when supplied*.
Do not copy the community claim that pre-1.2 rejects it. 1.1.16 and some fleet artifacts
were not tested. **Do not introduce a guessed version boundary, and do not silently retry a
real prompt after an unknown-flag failure.**

## Four local-mock streaming scenarios

Unmodified Seam decoder, header added only via a test-process-local transport wrapper:

- 1.2.2 persistent stream-JSON — 10 decoded updates, terminal `SUCCESS`, usage object
- 1.2.7 persistent stream-JSON — 13 decoded updates, same checks
- 1.2.2 one-shot `-p` JSON — 8 updates, natural process exit
- 1.2.7 one-shot `-p` JSON — 9 updates, natural process exit

One-shot retains Seam's per-turn process model; persistent was a probe, **not** a proposed
driver change.

**Cleanup caveat:** persistent-mode processes did not close within a 2s EOF wait or a
subsequent 2s SIGTERM wait and were reaped by SIGKILL. One-shot exited naturally. Not a
diagnosed production defect; the deadlines were short.

## Evidence level

- Real official binaries, digests matched against GitHub Releases.
- Disposable user/PID/mount/proc/network namespaces; loopback only.
- Auto-update disabled via `AGY_CLI_DISABLE_AUTO_UPDATE=true` **for test isolation only** —
  not a replacement for production immutability.
- No real provider credentials. The streaming scenarios used a loopback Gemini mock.

**Real-binary / local-mock evidence. Not a live-provider canary, not a full Seam end-to-end
run.** The API-key setup needs both a dummy key and `modelProvider: "gemini"` in the profile.

## Exact artifacts (executable SHA-256)

- 1.1.27 `d0fc0a68ce78a0b8890e54a894ef5d582dcdb4d1b4264cf29dffc0becc026689`
- 1.2.0 `77dc197a05ca2a47d143ad135a4679b28ef85976cfd268569233d2f3d08ce999`
- 1.2.2 `0735841949aaedc0ba4121a84b47b83b067b71af03d76897850077a4ee86bcdc`
- 1.2.7 `ac6a97924c7f0ac5065d0facf8c9e771975ef996069f3e9e50f9c7e27ba45fc4`

## Recommended Seam fix scope

Anchors refer to `80eb350011ca517715d3af5e8253730583a11bab`.

- `profiles/agy.ts:1204` `buildAgyPromptArgs` — carry a per-child CSRF argument alongside
  the private log and prompt flags.
- `profiles/agy.ts:1692` turn launch — generate and retain the token with the **turn-owned
  child**, not the logical ACP session or global runtime identity.
- `profiles/agy.ts:1813` and `agy-stream.ts:240` — pass that child's token to the
  subscription and add its header. Preserve Connect EOS error handling, fallback
  boundaries, cancellation and stream authority.
- `profiles/agy.ts:2997` `learnAgyCatalogFromSession` — authenticate enrichment against the
  same child. Fixing only the subscription leaves catalog enrichment unauthenticated.
- `profiles/agy.ts:2825` `fetchAgyUserStatus` — its separately launched `models` child needs
  its own launch/header pair for `RetrieveUserQuotaSummary`. Preserve prompt-free behaviour
  and lifetime bounds.
- `profiles/agy.ts:2554` `runAgyProbe` — thread owned connection details through the finite
  probe without coupling ordinary stdout model listing to LS availability.
- `agy-native-runtime.ts:575` — **keep verified descriptor-bound spawning intact.** Do not
  replace managed provenance or attach to an ambient AGY process.
- `agy-lifecycle.ts:126` and `probe-process.ts:203` — register the generated token for
  explicit redaction wherever child diagnostics surface. Avoid raw argv logging.

Use a **new random token per child**, including a continuation child loading the same
conversation. Keep it out of durable session identity, caches, reports and configuration.
The conversation ID remains the continuity identifier. If an artifact cannot accept the
flag, preserve compatible existing operation for that binding and refuse only unsupported
promotion — not the whole agent fleet.

## Acceptance before upgrading

Retain `docs/agy-upgrade-gate.md`'s requirement for a separately approved canary naming
host, candidate digest, model, prompt budget, allowed tools, cleanup and stop conditions.

Required checks, each with the consequence of omitting it:

- Launch/header agreement plus missing/wrong-token controls — stops an unauthenticated
  HTTP-200 envelope being read as a working stream.
- Concurrent children with distinct tokens and private logs — stops one turn subscribing to
  another child's server.
- Respawn/continuation with a new token and the same conversation — stops stale local
  authentication breaking preserved history.
- Stream, metadata and finite quota RPC coverage — stops a partial fix restoring text while
  silently losing metadata or quota.
- Tested legacy artifacts and unsupported-flag behaviour before a real prompt — stops
  breaking working pins or replaying a prompt after startup failure.
- Cause-preserving fallback and mid-stream rejection tests — stops false success or
  replacing a partial authoritative stream with stdout.
- Explicit redaction checks for echoed arguments/header errors — stops the capability token
  appearing in logs or cards.
- Owned-process cancellation, timeout and cleanup — stops a successful reply hiding
  abandoned AGY/tool processes.
- Separately approved provider canary — stops the narrow local-mock result being promoted
  into a full compatibility claim.

**Current limits:** no real Google-subscription canary; no macOS/Windows execution; no live
MCP/tool-approval, thinking, schema or resumed-session verification; no full Seam suite.

Separately, a newly reported 1.2.7 slow-subscriber/cancellation issue
(google-antigravity/antigravity-cli#1081) was not reproduced and is not attributed to CSRF —
another reason this is not blanket approval for 1.2.7.

## On pinning

The research is explicit: **keep immutable version pinning.** The handshake does not prevent
self-update and does not establish compatibility for every other capability. See
[`agy-pinning-context.md`](./agy-pinning-context.md) and #415 for why the pin exists
independently of any single version's defects.
