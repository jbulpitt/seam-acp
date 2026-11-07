# Built-in AGY ACP integration

This is the native `agy acp` integration under [#1098](https://github.com/jbulpitt/seam-acp/issues/1098).
`makeAgyAcpProfile` is exported for integration and validation. The existing
`makeAgyProfile` registration, managed executable pins and deployed sessions
have not switched. Switchover is a separate decision.

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

Errors use the existing AGY classifier and retain their ACP code, message and
data for core and bridge consumers. Established authentication failures reach
the existing sign-in routing; unknown failures remain unclassified.

The catalog has a separate `agy-acp-stdio-v1` backend scope. Context remains
unknown when no context metadata is supplied. Per-turn token totals are not
converted to context occupancy. Image support in the catalog describes the
agent's advertised ACP transport capability; it is not a live vision result
for every advertised model.

## Evidence and unresolved questions

The observations below are specific to Linux x86-64 AGY CLI 1.5.3 with ACP SDK
1.7.0, collected on 2026-11-07. They are not claims about another official
server, the older standalone `antigravity-acp` package, other versions or all
accounts. An unresolved item is not an accepted feature gap.

- **Catalog and selection — observed:** five canonical model rows. Gemini,
  Opus and Sonnet advertised low/medium/high; GPT-OSS did not advertise a
  separate thinking selector. Metadata selection of third-party models ran;
  third-party generation did not.
- **Thought text — observed:** a Flash/high modular-arithmetic task using an
  owned MCP fixture emitted two live thought chunks through the existing core
  handler. Native wire replay on load also contained thoughts; core suppressed
  replay. The prior small read-only probe's zero chunks did not establish
  absence of thought support. Executable symbols and call sites also contain
  the thought path, which alone would not have proved live emission.
- **HTTP MCP — observed:** an owned tool returned its unique literal in fresh
  and loaded sessions with `--process-per-session`. Supplied server entries
  went through existing core new/load plumbing.
- **Load/reapply — observed:** a fresh native process loaded the owned session;
  existing core reapplied Flash/high, both readbacks matched, and literal
  continuity worked. Actual served-model identity was not independently
  established. This does not validate older Seam backend mappings.
- **Cancellation — observed:** cancellation during an owned waiting MCP tool
  settled as cancelled, then the immediate next turn completed. Both native
  front processes exited with code zero. This is one scenario, not arbitrary
  crash/network/recovery coverage.
- **Context capacity and occupancy — unresolved:** no context fields appeared
  in the per-model ACP metadata or usage-update notifications. `/context` was
  not advertised as an ACP command. A fresh standalone CLI `/context` request
  returned an explicit interactive-only error with zero model turns. An
  attempted interactive inspection did not reach a context display; it showed
  startup/onboarding and sign-in text, so neither authentication completion nor
  context values are claimed. The official status-line schema documents
  `context_window_size`, `current_usage` and used/remaining percentages. Those
  are positive evidence of a CLI context surface, not proof that ACP forwards
  it. Its availability to ACP still needs investigation. Model capacity, harness
  effective context, current occupancy, turn usage and account quota must
  remain distinct.
- **Legacy sessions and management — unresolved:** mapping/cascade ids,
  high-water marks, history, list/clone/delete and compaction need an explicit
  compatibility design. No existing user session was probed or migrated.
- **Other inputs and lifecycle — unresolved:** image inputs/inspection,
  embedded resources, structured output, steering, elicitation, helpers,
  concurrent sessions and crash/disconnect recovery require separate evidence.
  Native advertisements and release-note claims do not satisfy those checks.

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

Switchover requires a reviewed disposition for every unresolved capability and
an explicit decision on any remaining tradeoff. This initial integration does
not select a fallback, new state store, guard, sandbox or runtime feature flag.

## Verification

`test/agy-acp-profile.test.ts` runs a real stdio fixture through the SDK and
existing core. It covers fresh per-model catalog sessions, variable and absent
effort selectors, honest client identity, unknown context, load/reapplication,
exact thought/context events and fixture ACP error passthrough. Bare fixture
auth errors also pass through core classification into the existing sign-in
decision; these tests do not establish new native error semantics. Its usage
fixture deliberately differs from the prompt token totals.

The live checks used disposable owned conversations and HTTP MCP fixtures;
production/staging deployments and existing session data were not changed.
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
