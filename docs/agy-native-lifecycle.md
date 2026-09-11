# Native AGY lifecycle (R5)

Native `agy` remains primary; optional `agy-package` is unchanged. R2's reduced
provenance and descriptor-bound launch are retained, not replaced by a second
identity scheme. R0 restoration records, pending rebuilds, provider conversation
data and ACP mappings are not deleted by cancellation or disposal.

## Ownership and completion

- Each virtual ACP runtime owns its session map and uniquely allocated private
  MCP HOMEs. Disposal removes only those generated HOMEs after native teardown;
  symlinked provider state and the durable ACP mapping are retained.
- Each prompt owns one lifecycle, a private log, an optional schema, child
  stdio, the LS subscription and one detached process group. Concurrent prompt
  replacements serialize. A failed reap keeps the prior owner attached and
  refuses replacement rather than overlapping a possibly live child.
- The interactive deadline starts before catalog waiting/spawn. It uses the
  configured print timeout (600 seconds by default), independently of the CLI's
  own timer. LS discovery remains limited to 90 seconds and conversation-id
  discovery to 30 seconds, both also observing the turn deadline/cancellation.
- Streaming has no finite-probe total-answer byte ceiling. The retained JSON
  result is capped at 1,000,000 bytes; stderr is discarded rather than retained
  or rendered, and more than 256,000 bytes terminates the turn.
- Stream readers cancel their HTTP body and release their lock on normal EOF,
  early IDLE break, protocol failure and cancellation, before process teardown.
  Native LS has no session-close RPC here: continuity is the saved cascade ID
  and step high-water mark, not a deleted provider conversation.
- Cleanup sends TERM to the owned process group, waits 500 ms, escalates to
  KILL, then waits up to 2 seconds. Both leader exit and group disappearance
  must be observed. `not_reaped` wins over cancellation/success. This is process
  ownership, **not** a security sandbox: a program deliberately escaping its
  process group is not contained by a process group.
- Cancellation is an ACP notification, not a cleanup acknowledgement from the
  client transport. The native handler awaits cleanup; the **prompt's settlement
  and virtual process exit** are the observable completion boundaries.
- Cached finite discovery/quota probes retain their existing R4 protocol and
  cache ownership but now use `runBoundedProbe`, with its ordered session /
  connection finalizers, bounded output and explicit group reap. Catalog
  lifecycle failures propagate as failures instead of being replaced by an
  empty catalog. R2's existing bounded descriptor version check is unchanged.

All timers/listeners/readers created by the turn are released at completion.
Local filesystem work and ACP notification delivery remain cooperative IO; this
does not claim JavaScript can forcibly cancel an arbitrary uncooperative promise.

## Necessity audit (#307)

Each added bound/check has an observable failure it prevents:

- Prompt ownership/serialization: concurrent replacements can otherwise launch
  two children after awaiting the same predecessor.
- Reap-before-release and failed-reap refusal: signalling alone otherwise lets
  replacement work run beside a TERM-resistant old child.
- Process-group launch/termination: a CLI can exit while its LS/tool descendants
  survive; killing only the leader misses them.
- TERM grace/KILL/reap deadline: TERM can be ignored or signalling can throw;
  without escalation and an observed exit, cleanup can hang or falsely succeed.
- Host turn deadline: a wedged CLI can ignore `--print-timeout`; the host must
  cancel discovery/streaming/result collection itself.
- Missing-stdio refusal inside ownership: partial startup can still create a
  real child; touching a missing stream before cleanup leaks it.
- Clean-exit startup check: an exit before LS discovery cannot fulfill a turn,
  even when its code is zero.
- Stderr discard/byte limit and fixed diagnostic codes: native diagnostics can
  contain credentials, prompt text or paths; exposing them leaks that data,
  and retaining a flood exhausts memory. No chunk-level secret guessing is used.
- Structured-output limit: the whole result is buffered, unlike incremental
  native prose; without a pre-retention cap stdout can exhaust host memory.
- Connect frame and metadata limits (8 MiB): corrupt length prefixes, oversized
  logs or HTTP bodies otherwise cause unbounded allocation/buffering.
- Malformed/truncated frame refusal: silently skipping corruption loses native
  thinking/results while reporting a successful turn.
- Reader cancel/release: an early loop break otherwise leaves an HTTP reader
  locked and its connection open during process teardown.
- Abortable discovery/retry waits: a caller cancellation must interrupt a
  hanging health request, not wait for an unrelated discovery timeout.
- Opt-in validator nonzero completion: its existing protocol parses output on
  any non-signal exit; guessing a single allowed code would drop valid lists.
  Spawn, signal, timeout and overflow failures still fail the probe.
- Unique private HOME even with zero MCP servers: returning `undefined` inherits
  global tools; reusing a HOME lets an old runtime delete its replacement's config.
- Empty helper MCP config: supplied/default servers otherwise leak into a
  sandbox-intended helper. Helper factory routing itself remains R8.
- Mode-0600 schema/log files and cleanup on failure: umask defaults and partial
  startup otherwise leave readable private request material behind.

## Sandbox evidence and limits

The installed native CLI's read-only `--help` describes `--sandbox` as enabling
terminal restrictions and `--dangerously-skip-permissions` as auto-approval of
tool permission requests. **Both profiles still bypass permission prompts by
default.** R5 does not add/remove advertised permission capabilities.

The production native-profile fixture checks the actual launched argv, private
HOME and parsed MCP file: sandbox flag present, only the private cwd added,
global staging absent, and no supplied/default MCP server inherited. This is
Seam launch-policy evidence, **not proof that the installed CLI blocks filesystem
or terminal operations**. A prompt saying “read only” is not a sandbox.

Installed-CLI enforcement remains an explicit live acceptance gate pending
separate owner approval. It must use a named model/host, fresh disposable
sessions, bounded prompt budget, synthetic inside/outside sentinel files and a
local synthetic MCP endpoint. Assert actual allowed/denied operations and
unchanged outside sentinels; stop on any unexpected access. Do not use existing
conversations, real credentials as test payloads, or production worktrees.

## Scope left to other stories

- R3 (#259): session-local model selection/global settings.
- R4 (#260): native catalog authority, discovery redesign and removal of
  throwaway inference probes. No such live probe was run for R5 testing.
- R6/R7: translation/replay refactoring and restart orchestration.
- R8 (#264): MCP/helper factory parity; package-backed helpers are not silently
  moved to native here.
- R9 (#265): deployment/canary rollout. Nothing is deployed by this change.
