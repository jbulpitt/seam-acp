# Native AGY capability contract

Status: R1 contract baseline for [#257](https://github.com/jbulpitt/seam-acp/issues/257),
under the delivery tracker [#256](https://github.com/jbulpitt/seam-acp/issues/256).

## Identity and scope

Seam's native `agy` adapter is the primary implementation covered here. The
separately named `agy-package` adapter remains optional and is neither removed
nor used as evidence for native behavior. Package title metadata and private
conversation SQLite are not thinking sources for this contract.

R1 freezes observed behavior so later AGY stories have a regression gate. R2
now extends that gate with the launch/provenance rules in
`docs/agy-native-runtime.md`; it does not change model selection, catalog,
lifecycle, persistence, helper routing, deployment, or production state. R0's
restoration ledger and next-turn rebuild gates remain untouched.

The executable fixture and sanitized traces live in
`test/fixtures/agy-native-capabilities/`. `provenance.json` records the CLI,
adapter, model fixture identity, evidence level, and immutable source stamps.
No fixture is marked live-verified, and the synthetic model identity is not a
model self-report or a claim of live correctness.

## Contract clauses

- Native `plannerResponse.thinking` cumulative updates become only incremental
  ACP `agent_thought_chunk` updates, then core `agent-thought` events. Both full
  and simple status cards render those thoughts in their observed order. The
  full terminal card retains the exact ordered thought lines, and the simple
  card history observes them chronologically. Tool labels and opaque tool
  payloads cannot satisfy the thinking assertion.
- Native `plannerResponse.modifiedResponse` cumulative updates finalize to the
  exact visible message once. Connect envelopes split inside multibyte Unicode,
  partial deltas, and multiple turns retain their order and content.
- Observed read, edit, and execute step types become stable tool start/update
  events. Failed native tool status remains failed. Opaque command output,
  patches, and errors are not promoted to assistant text or thinking.
- `metadata.modelUsage` supplies monotonically increasing ACP usage updates.
  `AgentRuntime` supplies the core context inputs used by status and the live
  Discord turn crosses the production AGY auto-compaction predicate; the real
  `runAgyAutoCompact` consumer receives the retained usage as `tokensBefore`.
  Card expectations are fixture-owned literals, not values recomputed by the
  production formatter under test.
- A persisted native conversation ID and step high-water mark survive runtime
  disposal/load. Replayed old indices are suppressed and only the resumed
  turn's new indices are emitted.
- ACP cancellation interrupts the active native turn, settles it as cancelled,
  and leaves the persisted conversation mapping intact. This is behavioral
  evidence only; bounded process-tree cleanup belongs to R5.
- Native initialization advertises embedded context. Text attachments are
  included as text resources; unknown binary resources are represented as
  binary and flattened only to a non-text placeholder, never decoded as text.
  Native AGY does not advertise ACP image input. The existing separately
  package-backed vision helper remains unchanged; its factory/tool-scope audit
  belongs to R8 ([#264](https://github.com/jbulpitt/seam-acp/issues/264)).
- MCP configuration is written under the ACP session's private HOME and the
  exact supplied server reaches the spawned native CLI. It does not become a
  global MCP write. R2 additionally requires mode-0700 session HOME directories,
  a mode-0600 MCP file, and resolution through the same verified runtime tuple.
- Native inventory identifies the runtime as `virtual-acp-native-cli` and
  carries only an opaque launch-identity digest, exact artifact source/version/
  digest, session cwd policy, and approved environment key names. Executable,
  root and cwd paths, raw credential scope, environment fingerprint, and
  environment values stay private. Local and bridge construction use the same
  runtime tuple.
- Every native child executes an independent duplicate of a cached anonymous
  descriptor-bound snapshot whose bytes were hashed from the retained master.
  Digest verification precedes bounded version execution; both the version
  probe and real child receive the launch duplicate as fd 3, so a
  post-verification pathname replacement cannot change executed bytes and
  concurrent launches cannot share an offset. Local startup and bridge hello
  append only the reduced provenance record to the durable audit ledger.
- Structured turns pass the reserved schema through `AgentRuntime`, create the
  native schema argument, accept only the CLI's `structured_output` envelope,
  suppress planner progress as the result, and remove the temporary schema.
- Removing either `plannerResponse.thinking` or the enclosing
  `mainTrajectoryUpdate.stepsUpdate` path makes the matching contract assertion
  fail. These negative controls prevent tool or unrelated metadata from
  accidentally satisfying the gate.

## Evidence boundary

The fixture shapes are source-confirmed from the native structural snapshot
documented in `packages/adapters/src/agy-stream.ts` and offline-reproduced
through the real native profile, ACP facade, core runtime, attachment mapping,
renderers, and the orchestrator's AGY threshold/consumer call. The R1
auto-compaction check stops after the real consumer receives the retained usage;
it does not claim that summary generation, session reseeding, or the separately
tested compaction workflow is reproduced by this fixture. Unknown native fields
remain opaque. A later compatibility gate may add separately approved
disposable live observations; R1 does not infer provider or model correctness
from fixture output.

The observed production warning that `AGY_BIN` did not match the configured
artifact was caused by an updater-controlled in-place path. R2
([#258](https://github.com/jbulpitt/seam-acp/issues/258)) now requires both
profiles' production configuration to use a non-writable content-addressed AGY
artifact and binds native launches to its version, digest, account scope, and
approved environment. Lifecycle/redaction enforcement still belongs to R5
([#261](https://github.com/jbulpitt/seam-acp/issues/261)).

Restart attempt ownership and continuation remain governed by
[#250](https://github.com/jbulpitt/seam-acp/issues/250), durable scheduled
occurrences by [#252](https://github.com/jbulpitt/seam-acp/issues/252), and live
work attribution by [#253](https://github.com/jbulpitt/seam-acp/issues/253).
This AGY contract consumes those boundaries and does not duplicate them.
