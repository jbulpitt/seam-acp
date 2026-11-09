# Built-in AGY ACP integration

This is the native `agy acp` integration under [#1098](https://github.com/jbulpitt/seam-acp/issues/1098).
`makeAgyAcpProfile` is exported as the separate, unregistered `agy-acp` identity
for integration and validation. The existing `agy` identity still uses
`makeAgyProfile`; its registration, managed executable pins and deployed
sessions have not switched. Activation is a separate decision. Evidence below
is scoped to the recorded heads; the current candidate is `b9a4d1d3` in
[draft #1102](https://github.com/jbulpitt/seam-acp/pull/1102).

## Adapter path

The factory runs `agy acp --process-per-session` over ordinary ACP stdio.
Google documents the second flag as required for client-supplied HTTP MCP
servers. `AgentRuntime` supplies MCP servers in session creation/loading and
handles permission requests, thoughts, tools, images and context-usage updates.
The factory does not translate native language-server streams or read private
conversation storage.

Catalog collection sends no model prompts. It initializes using Seam's actual
name, reads the native model selector, and inspects each model's thinking
selector in a fresh session. This avoids carrying the previous model's effort
into a default. Canonical model ids and `thought_level` values pass through
without baking effort into the model id. The existing core applies them on
new/load; no second persistence or reapplication mechanism is added.

Errors use the existing AGY classifier with `agy-acp` ownership and retain
their ACP code, message and data at the direct adapter/core boundary. Established
authentication failures reach the existing sign-in routing; unknown failures
remain unclassified. Shared bridge replies retain code/data, and the mux
restores them in the host-qualified error's `cause`. Real-WebSocket/Node
fixtures cover the selected replay/load/close errors and classifier fields;
this does not establish every management operation or native error case.

The catalog keeps the Antigravity brand and `google-antigravity` provider with
a separate `agy-acp-stdio-v1` backend scope. Existing routing keys catalog and
retained-session ownership by agent identity, so an `agy` binding does not
become an `agy-acp` binding even if their ACP session ids match. Legacy `agy`
invalidation still preserves its cascade id; `agy-acp` uses ordinary ACP
invalidation. No binding migration is added.
Context remains unknown when no context metadata is supplied. Per-turn token
totals are not converted to context occupancy. Image support in the catalog describes the
agent's advertised ACP transport capability; it is not a live vision result
for every advertised model.

The native adapter's `getTranscript(cwd, sessionId)` uses a separate owned ACP
connection to initialize, load the supplied session, collect matching-session
user/assistant text replay, then negotiate close and end/reap the transport.
The collector keeps exact text and chunk order; a role change or changed
non-null message ID starts a new message. Same-role chunks without IDs can
coalesce. Thoughts, tools, non-text blocks and context counters are excluded.
It sends no new-session, prompt, selector, list, fork or delete request. Core's
live replay suppression is unchanged.

The optional `getCompactionTranscript` exposes typed messages through the
existing `getTranscript` RPC with `format: "messages"`. The readable getter
still renders `### User` / `### Assistant`. Ordinary compaction partitions
whole typed messages before formatting older/recent text, preserving literal
role-looking headings and whitespace inside each message. An empty typed
array means no history: one read, no readable fallback, analysis or seed.
Nonempty arrays containing empty or whitespace-only text remain history.
Legacy string peers remain compatible, with the existing split/trim ambiguity;
the readable format is not a lossless parse format.

The getter uses the existing bounded collector, including its 45-second
default and 1,000,000-byte stdout ceiling; these are collector bounds, not
native history limits. Native RPC failures are retained through cleanup, and
close/transport cleanup failures cannot yield a successful partial transcript.
The mux's 30-second default caller wait is separate: caller expiry does not
cancel the host's collector. The desired wait/cancel contract remains open.

No full session manager is advertised. List/clone/delete, legacy-ID mapping,
rich history and broader reader isolation still need reviewed contracts or
evidence. Absent manager metadata does not disable the remote transcript proxy
or AGY-prefix auto-compaction: `agy-acp` matches that prefix, with the existing
usage/high-water/threshold gates. Actual controller/native analysis, seed and
rebind remain unrun. Registration and compaction policy are unchanged.

## Evidence and unresolved questions

The original 2026-11-07 observations and the older-head results summarized on
2026-11-08 used Linux x86-64 AGY CLI 1.5.3 with ACP SDK 1.7.0. Their heads remain
part of the evidence: `0dd64c32` recovery, `16dff288` inputs/inactive replay and
`e85b3dfe` held-reader/text observations. They are not revalidated at `b9a4d1d3`.
The current native typed-read/continuity observation and nonlive fullsuite06
are separate 2026-11-09 evidence at `b9a4d1d3`. None establishes another server,
the older standalone `antigravity-acp` package, every model/version/account or
served-model identity. An unresolved item is not an accepted feature gap.

- **Catalog and selection — historical observation:** five canonical model rows. Gemini,
  Opus and Sonnet advertised low/medium/high; GPT-OSS did not advertise a
  separate thinking selector. Metadata selection of third-party models ran;
  third-party generation did not.
- **Thought text — older native observation:** at `e85b3dfe`, the owned
  Flash/high workload produced seven thought-kind text/nonempty updates, an
  HTTP MCP tool call and two exact core/native text answers. Earlier small
  probes with zero thought chunks did not establish absence. This does not
  count downstream status-panel delivery or establish served identity.
- **HTTP MCP — historical observation:** an owned tool returned its unique literal in fresh
  and loaded sessions with `--process-per-session`. Supplied server entries
  went through existing core new/load plumbing.
- **Load/reapply — older native observation:** at `16dff288`, a fresh native
  process loaded the owned session; existing core reapplied Flash/high, both
  readbacks matched, and literal
  continuity worked. Actual served-model identity was not independently
  established. This does not validate older Seam backend mappings.
- **Host restart selections — fixture verified:** the real sessiond, holder
  and adapter-child restart path reapplies the last acknowledged model and
  config-option effort before continuation. It uses the existing resume
  record; pending/rejected values are not saved, and a snapshot without an
  effort selector clears the previous effort. Old records, legacy model-baked
  profiles and Codex mode restoration retain their existing behavior. Setter
  errors retain their RPC code/message/data and prevent continuation through
  the existing failure path. The restart fixture uses a fake ACP agent through
  registered config-option profiles; it does not establish native AGY host
  restart parity or served-model identity.
- **Owned native host recovery — older observation:** at `0dd64c32`, the
  standard sessiond, holder and adapter-child path recovered one disposable
  in-flight native conversation after precisely owned process loss. It loaded
  the same ID, reapplied Flash/high, completed original request7 once with the resumed MCP
  literal and `end_turn`, then closed. Untouched load readback was Argon/medium.
  This used an unregistered worktree inventory entry, passive byte observation,
  a minimal Seam client and retryCount0; it is not full Discord/reboot,
  production retry-policy or served-model proof. Earlier startup/worker-exit
  failures retain their original outcomes and unknown causes.
- **Cancellation — historical observation:** cancellation during an owned waiting MCP tool
  settled as cancelled, then the immediate next turn completed. Both native
  front processes exited with code zero. This is one scenario, not arbitrary
  crash/network/recovery coverage.
- **Readable transcript — older native observations:** at `16dff288`, an
  inactive reader returned the exact Unicode readable transcript and same-ID
  reuse completed. At `e85b3dfe`, a separate reader returned the own-User
  snapshot while its owner prompt/MCP stayed held; explicit release and the
  same-connection followup then completed. That snapshot predates final history.
- **Typed transcript and continuity — current native observation:** at
  `b9a4d1d3`, one typed read returned the whole 275-byte own User at ordinal
  zero, with exact-text/shape/role/order/no-normalization predicates passing.
  The preplanned second prompt completed on the original owner after the first
  `end_turn` and typed/route gates. This used the real native getter over a
  disposable local HTTP-upgrade WebSocket/BridgeHub/mux/public proxy/shared
  dispatcher, not a deployed controller/sessiond/Discord path or native
  compaction. Input/oracle agreement and literal header/Unicode/whitespace
  characteristics are author-attributed; exactness is supported by operator
  predicates and inspected source, not independent raw review. Reader-internal
  request/lifecycle bounds remain source-derived. No general active-reader
  isolation, rich/compacted/multiturn history or memory/served-identity proof
  follows.
- **Image and embedded context — older native observation:** at `16dff288`,
  one core prompt carried one image and one embedded text resource; independent
  visual/resource predicates and a strict JSON comparison passed. This was not
  part of native03 and does not establish every-model vision or Discord/CDN
  parity.
- **Context capacity and occupancy — unresolved:** earlier scoped ACP
  observations did not yield an effective capacity or occupancy contract.
  Reviewed primary sources identified no exact built-in 1.5.3 ACP route or
  trigger in that review's version/date scope. CLI status-line/TUI, standalone
  and protocol surfaces remain relevant, but do not establish that vendor ACP
  contract. The upstream clarification remains unsent pending user choice.
  Model capacity, harness effective context, current occupancy, turn usage and
  account quota remain distinct. Missing fields or zero events do not
  establish feature absence.
- **Legacy sessions and management — unresolved:** own new/load/close and
  bounded text replay do not establish list/fork/delete/repair, rich history,
  high-water compatibility or migration of legacy mapping/cascade IDs. Close
  is not delete, and a native returned fork ID differs from a caller-chosen
  clone ID. No existing user session was probed or migrated. The compaction
  path's source/nonlive coverage is separate from actual native execution.
- **Broader inputs and lifecycle — coverage limits:** steering, elicitation,
  helpers, rich/tool/thought/media replay, concurrent sessions and broader
  crash/disconnect scenarios remain unmeasured. Advertisements alone do not
  establish them; these limits do not automatically select new tests or blocks.

The first combined live operator stopped before sending cancellation: native
ACP reported an unexpected session-worker exit, and the operator left a prompt
rejection temporarily unhandled. Its MCP fixture incorrectly reused one
stateful transport across client lifetimes. The replacement fixture used a
transport per MCP client and attached the prompt outcome handler immediately;
a separate new-session check passed. The original failure remains a failure,
and its native worker-exit cause is unproven. During that failed scenario the
model searched outside the fixture for MCP configuration; those raw captures
are excluded from published evidence. No product workaround was added.

## Investigation standard before accepting a gap

For each capability, retain the exact executable/version, client identity and
capabilities, settings, workload and wire result. Review primary documentation,
the matching protocol schema and available implementation evidence, then test
the configuration or workload that discriminates the remaining alternatives.
Record negative results with their limits. Do not repeat prompts merely to
obtain an optional event, substitute tool labels for thought text, derive a
context window from token totals, or turn “not advertised” into “impossible.”

Activation remains deferred. Management/legacy-ID compatibility, the compaction
path, caller/host deadlines and unknown-context tradeoffs need reviewed
disposition; broader uncovered scenarios are not automatic defects or repeat-test
gates. This integration selects no fallback, new state store, guard, sandbox or
runtime feature flag.

## Verification

At `b9a4d1d3` on 2026-11-09, fullsuite06's build and complete standard nonlive
suite passed: **542 files, 7,622 passed cases, zero failed, one skipped and five
todo**. Profile 28, compaction 11 and wire 8 are cases within that same run,
not a new focused invocation. Dedicated test typing remains unrun. Earlier
RED/STOP results remain unchanged. The b9a4 test-only change owns both
promise outcomes immediately and joins settlement before fallback cleanup; it
adds no optional progress diagnostics or diagnosis of the earlier missing log.

`test/agy-acp-profile.test.ts` runs a real stdio fixture through the SDK and
existing core. It covers fresh per-model catalog sessions, variable and absent
effort selectors, honest client identity, unknown context, load/reapplication,
exact thought/context events and fixture ACP error passthrough. Bare fixture
auth errors also pass through core classification into the existing sign-in
decision; these tests do not establish new native error semantics. Its usage
fixture deliberately differs from the prompt token totals.

[The compaction tests](../test/compaction-remote-execution.test.ts) join the
actual factory/SDK/Node getter and production host dispatcher with a mocked hub
transport and ordinary analysis/seed runtimes. Independent literal expectations
check older/recent partitioning, exact summary/pinned inputs and recent seed
content, plus owner/binding/location/model/effort and error controls. They cover
literal role headers, whitespace and empty versus nonempty typed history.
These are native-free fixtures, not real-WebSocket compaction or actual native
LLM analysis/seed/rebind.

[The separate wire tests](../test/remote-transcript-wire.test.ts) exercise a real
BridgeHub/WebSocket/mux and shared dispatcher with Node ACP peers. They cover
typed exactness, legacy/native same-ID routing, string-peer compatibility,
partial replay and structured load/close errors without a readable retry.
The stdio profile fixtures separately cover replay filtering and collector
timeout/overflow paths. Neither fixture group is the actual native03
observation or universal reader-isolation proof.

Live checks used disposable owned conversations. Earlier MCP workloads used
owned HTTP fixtures; native03 used the separate no-tool typed-read/continuity
workload described here. Production/staging deployments and existing session
data were not changed.
Native account logs and the first contaminated raw captures remain local and
excluded. Process checks cover captured identities and accessible owned paths,
with sampling/permission limitations rather than a global absence claim.

## Primary references

- [CLI ACP guide](https://antigravity.google/docs/cli/acp/)
- [Editor ACP guide and flags](https://antigravity.google/docs/ide/extensions/acp/)
- [1.5.1 model and session changes](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.1)
- [1.5.3 disconnect-saving fix](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.3)
- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [CLI context breakdown](https://antigravity.google/docs/cli/commands/context/)
- [CLI status-line context schema](https://antigravity.google/docs/cli/statusline/)
