# Package-backed Antigravity ACP

Issue #228 cuts the public agent ID `agy` over to a reviewed
[`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp) binary.
The former in-process implementation is `agy-old`; it is a temporary,
operator-only rollback profile and is disabled unless
`AGY_OLD_ROLLBACK_ENABLED=true` and `AGY_OLD_CLI_PATH` names its executable.
Failure of `agy` never activates `agy-old`.

Existing thread, channel, preset, schedule, naming, role, repository, and model
records keep the public ID `agy`, so the cutover needs no database rewrite.
The two wrappers use different session stores. A legacy handle is not present
in `antigravity-acp`'s `~/.agy-acp/sessions.json`, so load returns
`resource_not_found`. Seam clears only that failed ACP handle; the thread's
configuration and Discord history remain available for a fresh session or
deterministic rebuild. `agy-old` retains its own durable handle when rollback is
explicitly selected.

## Immutable supply chain

The reviewed upstream identity is:

- Package/release: `antigravity-acp` v1.1.0
- Annotated tag target: `e0a3d22c7515f0ca0692c668811879623b74519a`
- Source tree: `923e7d93dc09c555dba6e36b0799a528461f966f`
- Release/tag/commit signature status: unsigned; integrity relies on the
  immutable commit plus GitHub release asset SHA-256, not a signing claim
- ACP SDK resolved in `bun.lock`: `@agentclientprotocol/sdk` 1.0.0; Seam's client is
  backward-compatible ACP v1

Official compiled release assets avoid a Bun runtime dependency:

- macOS arm64: `agy-acp-darwin-arm64`, SHA-256
  `9ef7afa432341c05d6c049d143349ea71fbb48989813ba625054a7224e2804fc`
- macOS x64: `agy-acp-darwin-x64`, SHA-256
  `ed84139ad6d308e528cc2193100997c0e38a22da8cec4208cbcc88e9884caf95`
- Linux arm64: `agy-acp-linux-arm64`, SHA-256
  `2138f694643bb473e077cb189eb5058ef6e28eaa468d29c17ffc0835833b5d8a`
- Linux x64: `agy-acp-linux-x64`, SHA-256
  `742f703f97dfe54325198a21f54363196e8a0483052ce0f4661ed96eeef1fbe2`
- Windows arm64: `agy-acp-windows-arm64.exe`, SHA-256
  `f81d050ff025d4968e6cffe86d1ca175a1944cedc5a289db6d77e57f8e13981f`
- Windows x64: `agy-acp-windows-x64.exe`, SHA-256
  `42943eee35e7d9bb51ad03b80b397f416ecf8c65e6a5dc414c14f2ac3cec9029`

The adapter rejects a digest that is not the reviewed asset for the current
OS/architecture and hashes the local file before every catalog refresh and
session spawn (with a stat-keyed digest cache). Production supplies an exact
absolute `AGY_ACP_BIN`, exact absolute `AGY_BIN`, exact `AGY_VERSION` (the first
line from `AGY_BIN --version`), exact `AGY_SHA256`, empty wrapper argv, exact
cwd, and `AGY_SKIP_DOWNLOAD=1`. Both direct commands use the shared bounded,
redacting, TERM-to-KILL-and-reap lifecycle. Catalog publication fails if the
observed AGY version or digest does not match. It never calls the wrapper as a
version command:
v1.1.0 is an ACP server, and doing so could enter its binary-resolution path.
Installation and upgrades are offline operator actions outside Seam.

The pinned upstream wrapper normally prefers an executable `agy` sibling beside
its own compiled executable over `AGY_BIN`. Seam therefore requires
`AGY_ACP_BIN` to be a real, non-symlinked path and checks the sibling location
before every refresh and spawn. An executable sibling is accepted only when it
resolves to the exact configured, digest-pinned `AGY_BIN`; any other sibling
fails closed before the wrapper starts. Thus direct evidence and ACP sessions
cannot select different AGY artifacts.

## Authentication and security acceptance

Authentication belongs wholly to the runtime host and the effective service
`HOME`. Seam never performs login, reads an OAuth value, copies credentials, or
puts an account identity into catalog scope. `AGY_CREDENTIAL_SCOPE` is a short
semantic label such as `antigravity-oauth:primary`; emails and paths are
rejected. The child environment is allowlisted to ordinary OS/runtime variables
plus `AGY_BIN`, `AGY_SKIP_DOWNLOAD`, and `AGY_CONVERSATIONS_DIR`, preventing
Discord/provider secrets in Seam's environment from reaching the wrapper.
Runtime stderr is line-bounded, total-bounded, and redacted before logging; ACP
error objects are recursively redacted before the SDK can persist or surface
them. Raw errors are not retained as `cause` objects.

The reviewed upstream wrapper itself awaits the complete underlying `agy`
stderr body before it emits its bounded outer diagnostic. Seam bounds and
redacts everything that can reach its SDK, persistence, or logs, but cannot
bound that private in-process allocation without a patched upstream binary.
Independent security acceptance must account for this residual denial-of-service
risk; it is not represented as a safe stderr contract.

Upstream warns that unofficial use can violate Google's Terms of Service and
may suspend the Google account. Use a dedicated, risk-accepted account and
review Google's current terms before enabling this integration. Seam does not
perform or automate login.

Security acceptance is mandatory: v1.1.0's `buildAgyArgs` unconditionally adds
`--dangerously-skip-permissions`, including in its advertised “Standard” mode.
Therefore Seam's `ask`/`deny` approval setting does **not** control underlying
Antigravity tool calls. The profile fails closed until an operator sets
`AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED=true`. This flag acknowledges the exact
unsafe contract; it does not make that contract safe.

## Catalog contract

The wrapper's startup model option is not evidence. Its reviewed source:

- loads `~/.agy-acp/models.json` synchronously;
- discovers models asynchronously;
- retains cache after empty discovery;
- substitutes two hardcoded rows when `listModels` is empty; and
- treats the first model as current/default.

Seam instead invokes exact `AGY_BIN models` with the same allowlisted runtime
environment, parses the exact first-column IDs, rejects empty/duplicate/oversize
output, then starts a fresh wrapper through the shared bounded-probe lifecycle.
It never accepts `session/new` model options, even when they match direct
discovery, because those rows can be startup cache. It waits for a positively
identified later ACP `config_option_update` whose post-discovery rows have
exactly the same order-independent ID set. It then
selects every ID serially and requires exact `currentValue` acknowledgement.
Timeout, disagreement, missing configured default, selection drift, output
overflow, spawn failure, or unreaped process fails the candidate atomically;
the catalog service retains its last-known-good generation.

Every raw model-baked variant remains its own row. IDs and runtime IDs are
byte-for-byte equal, aliases are not invented, and the only effort is
`default`. Core receives standard schema/evidence/reduction-policy records and
contains no AGY parsing or suffix rules.

## ACP behavior and known boundaries

Pinned-source review confirms handlers for initialize, session/new,
session/load, session/list, session/resume, session/close, history replay,
prompt streaming, cancellation, resource-link/embedded-resource attachment
flattening, persistence, and process teardown. Isolated Seam fixtures exercise
initialize, session/new, exact model switching, close, late discovery updates,
timeouts, and the shared process lifecycle. The wrapper persists session bindings atomically in
`~/.agy-acp/sessions.json` and replays the configured conversation database on
load.

Two upstream limitations must remain truthful during independent QA:

- v1.1.0 ignores ACP `mcpServers`; it advertises empty ACP tools/resources and
  cannot claim Seam approval or MCP forwarding. Seam's fenced bridge controls
  remain available, but they are not ACP MCP forwarding.
- v1.1.0 does not emit structured ACP `usage_update` context telemetry. Its
  `/usage` special case is text output, while Seam's usage command invokes the
  exact host-local `AGY_BIN` usage reader.

These are explicit compatibility facts, not features Seam silently claims.
Independent QA must decide whether they satisfy the rollout scope before merge.
No real prompt may be run without an explicit safe test directory/account and
no prompt test may run on a family remote host.

## Bridge topology and rollout

Remote execution remains `controller -> Seam bridge -> antigravity-acp ->
host-local agy`. Inventory carries the exact wrapper path, empty argv, cwd,
allowlisted environment overlay, state/conversation directories, semantic
credential scope, upstream version/commit/source, artifact digest, and exact
underlying AGY executable/version/digest. Core has
no host paths and adds no SSH-per-turn or alternate protocol.

Before enabling a binding, verify read-only that its OS/architecture has a
reviewed artifact, both exact executables exist, bridge capability is current,
and host-local auth files are present without printing their values. Enrollment
of AGY-only hosts into safe rollout tooling is tracked separately from this PR.
No production catalog refresh, login, install, restart, or deployment belongs
to this procedure.

### Read-only readiness record (2026-09-09)

The established protected bridge-ID/SSH mappings were used. Host identifiers,
aliases, user paths, and tunnel endpoints are intentionally not duplicated in
this public document. No provider command other than `agy --version` ran, and
no file contents, environment, PM2 state, login, catalog refresh, or prompt was
read or changed.

- Reachable host A: Darwin/arm64; its exact configured `AGY_BIN` exists at
  version 1.1.27; Antigravity state and conversation directories exist
  (non-secret prior-use evidence, not proof of a currently valid OAuth grant);
  no reviewed wrapper exists in the audited operator paths; its deployed bridge
  checkout lacks catalog RPC capability. Git identity was unavailable from the
  read-only command.
- Reachable host B: Darwin/x86_64; its exact configured `AGY_BIN` exists at
  version 1.1.28; state/conversation directories exist with the same
  auth-readiness caveat; the wrapper is absent and the deployed bridge checkout
  lacks catalog RPC capability.
- Host C: its established tunnel endpoint refused the connection. OS,
  architecture, bridge, wrapper, AGY binary, and auth readiness remain unknown.
- Host D: unreachable for the same reason; all readiness fields remain unknown.

None of the four hosts is ready for this package-backed binding: the two
reachable hosts lack the reviewed wrapper and current bridge capability, while
the other two could not be audited. Installation/enrollment is intentionally a
separate rollout prerequisite.

The controller host was also checked read-only: Linux/arm64, its exact configured
AGY executable reports version 1.1.28, and state/conversation directories are
present, but no reviewed wrapper executable or wrapper state exists. Because
the exact reviewed wrapper was absent, no local live discovery/session smoke or
real prompt was attempted. No safe real-prompt scope was supplied in any case.
