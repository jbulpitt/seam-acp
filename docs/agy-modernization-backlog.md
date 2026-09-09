# AGY: native adapter restoration and selective modernization backlog

Status: proposed implementation backlog, 2026-09-09. Writing a story here does
not authorize its execution, a provider prompt, a remote deployment, or a fork.
Owner direction: restore the native Seam adapter as `agy`; retain the external
wrapper under the distinct `agy-package` identity. Do not delete either adapter.

## Outcome and boundaries

Keep the native adapter's real thinking stream, session-scoped MCP wiring,
structured output, usage updates, attachment handling and context continuity.
Adopt useful design patterns without making the external wrapper a dependency
of native AGY. Do not transplant its private SQLite decoder or its title-to-Think
workaround as a substitute for the native language-server thinking stream.

The review baseline is main `3345a14` (including PR #251). The external wrapper
is v1.1.0 / `e0a3d22`, the observed CLI is 1.1.28. These are evidence stamps,
not a promise of future compatibility. Upstream sources:

- https://github.com/shubzkothekar/antigravity-acp/tree/e0a3d22c7515f0ca0692c668811879623b74519a
- Original integration #228 / #245; thinking conversion #251.
- Shared catalog/probe foundation #236; restart ownership #250; scheduled
  occurrence durability #252; live work attribution #253.

The wrapper supplied standalone packaging, a shared stream/replay translator,
session-scoped model state and organized ACP session operations. Binary pinning,
environment/redaction controls and catalog reconciliation were Seam integration
work: they can be adapted without adopting the wrapper's omissions. Neither
implementation is an approval-security upgrade: both bypass CLI permissions by
default. Native AGY's sandbox option is useful but must be empirically validated.

## Delivery sequence

1. R0 identity restoration and R1 observed capability contract.
2. R2 native runtime descriptor and R3 session-local model selection.
3. R4 catalog/probe modernization and R5 bounded lifecycle/security.
4. R6 translation/replay extraction and R7 persistence/session operations.
5. R8 helper/MCP parity, then R9 remote packaging and R10 compatibility gates.

R1 is the gate for every subsequent behavioral PR. R3/R5 can be developed
independently after R2. R6 must consume the lifecycle and session ownership
contracts rather than introduce a second job framework. R7 recovery depends on
#250; schedule continuation depends on #252. Keep PRs independently reviewable.

## Shared definition of done

- Inspect the named implementation, its callers and existing tests before
  editing. Start from current main in a sanctioned `wt` worktree.
- First reproduce the concrete missing behavior. Fixtures must derive from an
  observed wire/storage shape, with sanitized text and source/version notes.
- Compile adapters before tests relying on workspace `dist` imports. Run strict
  changed-test/root typecheck, build, focused affected paths and appropriate
  full non-live regression with bounded worker concurrency. Distinguish sandbox
  failures from regressions by reproducing base/head; never hide a skipped gate.
- No production credentials or conversation text in fixtures, logs, public
  issues or reports. Preserve unknown data privately; do not guess semantics.
- Freeze commit and report the exact head, tested artifact and limitations.
  Independent QA must test observed behavior, not merely repeat fixture assertions.
- Live canaries require separate approval: exact model/host, new disposable
  sessions, prompt budget, tools permitted, cleanup and stop conditions. Never
  probe existing user conversations to claim parity. No autonomous remote rollout.
- Catalog/LKG, other providers, command budgets and unrelated user files remain
  unchanged unless explicitly included in that story.

## R0 — Restore unambiguous public identities (P0, immediate)

**Outcome:** native profile/factory/file are `agy` / `makeAgyProfile` / `agy.ts`;
external are `agy-package` / `makeAgyPackageProfile` / `agy-package.ts`.

**Implementation:** update adapter exports, controller construction, bridge
inventory/executable reporting, config descriptions, helper factory imports and
tests. `AGY_ENABLED` enables native only; `AGY_PACKAGE_ENABLED` independently
enables external only. Retain package digests and risk acknowledgement when that
profile is enabled. Deprecated native-path aliases may be read with documented
precedence; never implicitly enable the external profile. Keep native cascade
handle preservation tied to native identity, not the package profile.

**Migration gate:** inspect owning backend before changing existing records.
Do not pass an external ACP handle to native `loadSession`, overwrite it, or
silently create a new conversation. Present a dry-run of native, package,
unknown and remote bindings. Preserve model, effort, role, cwd, histories and
schedule ownership. Owner decides whether package-backed threads follow their
renamed backend or deliberately switch to native with a session migration/reset.
Remote hosts may be on older code: controller rename is not remote enrollment.

**Tests:** either profile alone/both/neither; invalid package config cannot
mis-enable native; aliases and precedence; inventory id equals profile id;
native handle survives invalidate while package invalidation remains distinct;
package thinking tests stay attached to package; no `Model info` card returns.

**Release:** only identity changes and agreed migration in the immediate PR.
Do not bundle the rest of this backlog, remove the installed wrapper, or delete
session maps. #244's old-adapter deletion plan is superseded by this owner
direction; amend/close it only when authorized rather than run its old soak plan.

## R1 — Evidence-backed AGY capability contract (P0)

**Targets:** `profiles/agy.ts`, `agy-stream.ts`, `AgentRuntime`, status panel,
MCP/attachment/vision helpers and their current tests. Add a focused fixture
directory with provenance metadata; no new runtime abstraction in this story.

**Implementation:** capture or replay sanctioned, sanitized native event shapes
for thinking, message deltas, read/edit/execute tools, errors, usage, interruption,
resume, embedded text/binary attachments and structured results. Record whether
each behavior is source-confirmed, offline-reproduced or live-verified. Record
the CLI, adapter and model used. Unknown binary fields/signatures are not text.

**Acceptance:** actual `plannerResponse.thinking` updates traverse native
adapter -> core `agent-thought` -> both card styles; tool labels/stdout never
substitute for thinking. Message finalization, usage/context/compaction inputs,
per-session MCP and schema output are independently checked. Negative controls
prove removing the relevant field/path breaks the expected assertion. Include
split Unicode, partial deltas and multiple turns. Do not claim live model
correctness from a model's self-report.

## R2 — Explicit native launch identity and environment (P1)

**Pattern:** borrow the explicit runtime descriptor and pinning used around the
package integration, not the package binary itself.

**Targets:** `makeAgyProfile`, `makeFakeAgyProcess`, CLI discovery helpers,
`AdapterRuntimeDescriptor`, bridge `loadHostAdapters`/`inventoryFromAdapters`.

**Implementation:** one native launch-spec resolver accepts executable, argv,
cwd, credential profile and approved environment. Expose a native descriptor
consistent with the actual virtual ACP/native CLI topology; do not advertise a
compiled ACP executable that does not exist. Support exact CLI version/digest
validation with bounded caching invalidated on replacement. Audit required
language-server and MCP-home environment before allowlisting; retain correct
per-session HOME/config isolation. Reuse resolver in catalog, quota, normal
turns and helpers. Never print env values or credential-shaped arguments.

**Acceptance:** local and bridge resolve the same configured tuple; alternate
CLI or credential scopes cannot borrow evidence; replacement digest fails
before execution; missing executable is an actionable error; unsupported host
stays unavailable without local fallback. Tests use harmless binaries only.

## R3 — Remove global model-selection side effects (P1)

**Targets:** native `setConfigOption`/model setter, `selectAgyTurnModel`,
`buildAgyPromptArgs`, `persistModelSelection`, settings readers.

**Implementation:** make selected model owned by each ACP session. Validate
against the current exact catalog binding and pass the canonical runtime model
in each invocation. Persist the session choice in its mapping, not the shared
AGY settings file. Read global settings only as an explicitly defined initial
default; an explicit session choice always wins. Preserve baked-effort model
variants. Changing default must not rewrite existing sessions. Retire the
global write only after verifying actual CLI selection behavior.

**Acceptance:** concurrent sessions A/B with distinct models remain isolated;
resume restores each choice; scheduled/vision helpers never change global or
interactive defaults; failed selection cannot partially commit state. Assert
settings-file hash unchanged. Separately approved live canary confirms runtime
model from authoritative metadata, not prompt self-report.

## R4 — Bring native catalog discovery onto shared contracts (P1)

**Targets:** native `getCatalog`, `fetchAgyAcceptedModels`, quota/status probes,
`manifestCatalogSource`, shared `runBoundedProbe` and core catalog service.

**Implementation:** keep rich language-server model metadata only when observed
under the same exact runtime/auth scope. Corroborate selectable IDs with a
bounded no-prompt CLI model list where supported. Do not treat a CLI name list
as proof of context size, thinking support or a default. Use structured evidence
per claim; unknown context is null, never guessed. Avoid hidden `-p ok` catalog
requests: identify which metadata requires startup and replace with no-prompt
observation or explicit approved fallback. Atomically refuse empty, malformed,
scope-drifted or default-drifted candidates. Consume shared LKG/reduction rules.

**Acceptance:** >25 models; exact-ID/context provenance; same runtime in probe
and execution; semantic credential isolation; unknown metadata stays unknown;
one end-to-end deadline; no children after completion; failure retains LKG;
small-catalog reduction and restart confirmation use existing core behavior.
No duplicate private schema validator or quarantine implementation.

## R5 — Native bounded lifecycle, redaction and real sandbox guarantees (P1)

**Targets:** native process setup, language-server discovery/stream client,
stderr handling, MCP-home setup, cancel/shutdown, shared probe helper.

**Implementation:** enumerate resources owned per turn and session; establish
bounded startup, stream, cancellation and finalization with explicit ownership.
Use shared lifecycle for finite probes; do not transplant probe-only semantics
onto a long-running interactive session without adapting its contract. Retain
session-before-connection-before-process cleanup. Bound retained stderr before
concatenation and redact at the earliest externally visible boundary. Reap
descendants after TERM/KILL; a timeout alone is not cancellation. Never delete
session material needed for approved restart continuation (#250).

**Sandbox subtask:** prove native helper `--sandbox`, no global staging and
no MCP inheritance are enforced by the installed CLI. Distinguish an instruction
asking for read-only behavior from a sandbox. Both profiles bypass permission
prompts by default; document this accurately. Do not silently remove or add
permission capabilities in a cleanup refactor.

**Acceptance:** missing stdio, partial startup, failed LS discovery, malformed
stream, stderr flood, synchronous kill failure, TERM-resistant descendants,
cancel while starting/streaming/closing and repeated disposal. Cooperative
cleanup settles before return; unreaped children are explicit failures; no
overlapping replacement child. Secret-bearing errors stay absent from returned
and durable status. Verify with a disposable child tree, not production signals.

## R6 — Shared native translation engine for streaming and replay (P2)

**Pattern:** upstream's shared Translator architecture, but using native
language-server events and preserving every R1 capability.

**Targets:** native `emitStep`, held text/thinking buffers, ACP tool mapping,
history/mapping code, `agy-stream.ts`. Extract a provider-specific pure module,
not a shared-core heuristic that affects other providers.

**Implementation:** normalize native steps into typed events carrying session,
step identity and content role. Separate pure translation from stream fetching,
IO, redaction, persistence and rendering. Stream mode emits append deltas;
replay mode emits historical content according to the existing resume contract.
Maintain independent thinking/text high-water marks. Specify correction/truncation
behavior, not just length-increase behavior. Use stable tool IDs and preserve
terminal status, edits, task/error metadata and event ordering.

**Acceptance:** deterministic replay of observed traces; no duplicate thought or
tool on repeated poll; replay cannot appear as a new live response; text and
thinking ordering preserved; partial updates/new turns do not bleed across
sessions. Every previous native fixture passes before deleting old branches.
No title metadata relabeled as genuine reasoning.

## R7 — Atomic session store and explicit ACP lifecycle operations (P2)

**Targets:** native mapping read/write, `sessionManager`, ACP new/load/config,
cancel/shutdown; core router only for an explicitly needed contract connection.

**Implementation:** extract a versioned store with schema validation, atomic
write/rename and serialized in-process updates. Decide and test cross-process
ownership/locking before claiming concurrency safety. Persist backend identity,
ACP-to-conversation mapping, cwd, selected model and progress markers. Keep
credential values out of the store. Quarantine corrupt input without overwriting
the sole recoverable copy. Add SDK-supported list/resume/close/delete methods
only where the implementation actually honors them; advertise no fake support.

**Acceptance:** concurrent session updates do not overwrite each other; crash
cutpoints retain old or new complete data; duplicate close/cancel is safe;
delete touches only the requested owned session; cancellation preserves native
conversation identity; unknown backend/session fails clearly without resuming
another conversation. Integrate #250 ownership/continuation, not original-task
replay. #252 scheduled occurrence identity remains a separate dependency.

## R8 — Preserve and revalidate MCP, structured output and helpers (P1/P2)

**Targets:** `prepareAgyMcpHome`, `buildAgyMcpConfigJson`, `SEAM_AGY_JSON_SCHEMA_META`,
`createAgyImageInspector`, compaction/isolated helper callers, core construction.

**Implementation:** preserve session-scoped stdio/HTTP MCP including headers
and remote reachable addresses. Avoid global credential writes and stale tokens.
Preserve JSON-schema file ownership, strict structured-output envelope parsing
and no ordinary stdout-as-result fallback. Audit each helper's selected factory:
a restored chat adapter does not automatically restore a helper still hardwired
to the package factory. Move helpers back only with their sandbox/tool-scope
contract verified; do not make unsupported package behavior seem available.

**Acceptance:** two simultaneous MCP scopes remain isolated; remote URLs never
point to controller loopback; image owner/staging checks remain enforced; no
global model mutation; ordinary tools remain hidden; schema mismatch/timeout
fails explicitly and private temporary files are cleaned on every path. Run
existing attachment, vision, structured-output and compaction tests. New paid
vision/compaction tests need a separate bounded approval.

## R9 — Reproducible native deployment and remote enrollment (P2)

**Pattern:** upstream's distributable artifact and explicit dependency manifest.

**Targets:** existing bridge build/artifact tooling (#241), adapter runtime
descriptor, AGY runbook; coordinate #243 rather than create a competing rollout
system. Native AGY already speaks ACP through Seam; a separate standalone binary
is optional and needs a demonstrated consumer before creating a packaging project.

**Implementation:** package current native bridge/adapters as an exact committed
artifact, pin actual CLI dependencies per OS/architecture and record protocol
capabilities. Reuse safe staging, drain, receipt and rollback tooling. Inventory
must distinguish native/package identities; old bridge IDs are not silently
reinterpreted by the controller. Document startup checks and explicit managed
baseline enrollment for legacy hosts.

**Acceptance:** deterministic artifact/install/import; Windows/macOS/Linux claims
only where validated; no auto-download/auth; dry-run refusal of mismatched
artifact/runtime; local/remote parity for model, MCP, cwd, thinking and cleanup.
Real host staging/activation remains separately authorized; controller tests
alone cannot certify remote deployment.

## R10 — Upgrade compatibility and performance release gate (P2)

**Targets:** native protocol/schema fixtures, package comparison harness,
upstream-monitoring documentation (preserve unrelated user edits), CI jobs.

**Implementation:** version-stamp sanitized traces and maintain a small capability
matrix from R1. Add non-destructive schema-drift detection: unknown fields are
observable counts, not silently assumed irrelevant; never log raw private data.
Run upgrade candidates against immutable fixtures plus separately approved
canaries. Record startup-to-first-event, first-text, completion-to-idle, cleanup,
memory and child counts under declared host load. Compare native baseline and
candidate using identical tasks/runtime versions where possible.

**Acceptance:** no promotion from catalog-only tests; thinking, MCP, usage,
structured output and session continuity have explicit verdicts. Report median
and tail behavior with sample counts; no speed claims from one run or code-size
comparisons. Stop rollout on capability regression. Successful migration, not
elapsed soak alone, is required before retiring any recovery path.

## Not included

- No fork of the external wrapper is required for the native improvements.
- No wholesale rewrite or private SQLite thinking decoder in the native path.
- No permission-policy redesign, restart/scheduler rewrite, new status-card
  fields, provider-wide changes or remote activation hidden inside an AGY story.
- No automatic implementation of all backlog items after identity restoration.
- No removal of `agy-package` or its installed artifacts/state without approval.
