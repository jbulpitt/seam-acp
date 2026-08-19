# Seam Bridge — generalized machine-to-machine agent conduit

**Status:** build-ready spec (D0–D11 locked) · **Created:** 2026-06-05 ·
**Updated:** 2026-08-18 (vetted vs. current code — see **§14 Amendment**) ·
**Owner:** jbulpitt · **Start at:** §9 PR0

> **⚠️ 2026-08-18 vetting.** The spine still holds — location-as-binding, co-located
> adapters, the command bus, keeping `makeMux`, and the PR0→PR4 sequence are all
> intact and arguably *more* valuable now (more agents; a worker pool that could run
> remote). But four systems built since 6/05 — **seam-MCP** (the agent-facing
> orchestration tools), the **config-mutation admin/participant/lock tiers**
> (#58/#71/#74), the **#78 command-tree rebuild**, and **turn-resume** (#75/#76) —
> intersect this spec and change requirements. **Read §14 before building PR3/PR4.**
> Body counts/anchors (agent roster, orchestrator LOC, `/seam sessions` path,
> thread-rename caveat) have drifted; §14.0 lists the cosmetic refreshes and
> §14.1–14.4 are the substantive changes (each written to become its own issue).

Reframe the "remote agent" from a bespoke *agent type* into a generic *transport +
command bus* so any agent (claude, copilot, agy, opencode, …) can run on any number
of other machines, selected as configuration rather than as separate picker
entries.

> **Legend** — `[idea]` · `[research]` · `[decided]` · `[blocked]` · `[done]`.

---

## Orientation — read this first (cold start)

Starting from empty context? Read this, then the files it names, before §0.

**What seam-acp is.** A Discord bot that drives ACP coding agents (Claude Code, GitHub
Copilot CLI, Antigravity = "agy", and opencode → LM Studio). Each Discord thread is a
session; one user message = one ACP `session/prompt` awaited to `end_turn`. Runs under
pm2; redeploy with `npm run redeploy` (writes a restart sentinel — the process
self-restarts). Persistent state lives in `data/seam.db` (SQLite: thread→session
mapping) plus each agent's own on-disk session store.

**What ACP is.** Agent Client Protocol — JSON-RPC over stdio. seam-acp spawns an agent
as an ACP server and drives it: `initialize` → `session/new` → `session/set_model` →
`session/prompt` (text/image content blocks) → streamed `session/update`s →
`stopReason: end_turn`. At `initialize` the agent advertises
`agentCapabilities.promptCapabilities` (e.g. `image: true`). Model/effort/capabilities
all ride this pipe — which is why a bridged agent inherits them "for free" (§3). Smoke
test: spawn `<agent> acp`, write those four JSON-RPC messages to stdin, read updates
from stdout (~70-line Node script).

**Read these files, in order:**
| File | What it is / why |
|---|---|
| `AGENTS.md`, `docs/model-management-runbook.md` | repo conventions + model/effort gotchas — first |
| `src/agents/agent-profile.ts` | the **`AgentProfile`** interface PR1 evolves into `AgentAdapter` (§4) |
| `src/agents/agent-runtime.ts` | how a profile is consumed: `spawn()`, `newSessionMeta`, effort, `sessionManager`, `promptCapabilities` |
| `src/agents/profiles/{claude,copilot,agy,opencode}.ts` | the four agents to recast as adapters (PR1) |
| `src/agents/profiles/remote.ts` | current remote bridge — `makeMux` transport to **keep**, copilot-shape to **delete** |
| `scripts/remote-agent-bridge.mjs` | current bridge script (transport + ad-hoc cmd bus + session handlers) |
| `src/agents/session-manager.ts` | `ISessionManager` (list/clone/delete/usage/transcript) |
| `src/platforms/discord/orchestrator.ts` | turn lifecycle, pickers, status cards, `/seam sessions` UI |
| `src/config.ts`, `src/index.ts` | env config + profile registration/wiring |

**Current `AgentProfile` (PR1's "from" state).** Members: `spawn()`, `defaultModel`,
`staticModels`, `threadAbbr`, the `effort` descriptor, `newSessionMeta(model, effort)`,
`whoami()`, optional `sessionManager`, `configDir`, `restrictDiscordAccess`. The adapter
(§4) keeps all of these and adds `listWorkspaces`/`prepare`/`install`/`describe`, and
routes `spawn`/sessions over the bus when remote.

**Dev loop.** `npm run build` (tsc) · `npm test` (vitest — ~4 *known* pre-existing
failures in `thread-rename`, ignore them) · `npm run redeploy` (build + restart
sentinel). `.env` is gitignored (config + secrets live there). (The old
`npm run patch-acp` step was retired at claude-agent-acp 0.54.1.)

**Companion specs:** [display-naming-plan.md](./display-naming-plan.md) (emoji/short-name
standard, consumed by D10) · [integrations-research.md](./integrations-research.md)
(future skills research — not needed to build the bridge).

---

## 0. Terminology (canonical — use these exact words)

- **seam-acp** — the core app and **control plane**. The *only* brain: it owns
  orchestration, the agent contracts, and all decision-making.
- **remote-bridge** — the per-host bridge process: **transport + command bus +
  agent-adapter host**. Carries ACP stdio and executes adapter methods on request.
  **No orchestration logic of its own.**
- **agent** — the **interface (adapter) to an actual agent CLI, regardless of where
  it runs.** *All* agent-pertaining work — spawn, session management, usage,
  whoami, workspace/cwd detection, pre-spawn setup — runs **on the same system the
  agent runs on.** Addressed as **`agentId@location`**, where
  `location ∈ { local, <bridgeId> }`.
- **bridge / location** — a host reachable via a remote-bridge connection.
  **Multiple bridges run concurrently** against one seam-acp.

So the whole system is: **seam-acp ⇄ (local adapter | remote-bridge ⇄ remote
adapter)**. The remote-bridge is just the *wire* that lets seam-acp reach a remote
agent-adapter.

## 1. Motivation

"Where does it run" is orthogonal to "what agent is it," yet today a remote agent is
its own species (`copilot-remote-mac`). Stop modeling location as identity; model it
as a **binding** on a single agent definition: *"Is this **agy** agent running
locally, or on the **mac** bridge?"*

## 2. Design decisions (locked)

- **`[decided]` D0 — Multi-bridge by default.** N remote-bridges connect to one
  seam-acp concurrently. Everything (selection, commands, sessions) is scoped per
  `(bridge, agent)`.
- **`[decided]` D1 — Location is a binding, not a type.** One agent *definition*
  (its adapter); selectable instances are `agentId@location`
  (`claude@local`, `claude@mac`, `agy@linux-box`). Picker UX = pick agent → pick
  where. Each `agentId@location` is a distinct addressable identity / DB key.
- **`[decided]` D2 — No cross-location migration.** A session is **pinned for life**
  to the `agentId@location` it was created on (its storage physically lives there —
  see D3). Clone/fork stay in place. Not a restriction we impose — the only coherent
  model once storage is co-located.
- **`[decided]` D3 — Agent-local everything.** Session mgmt, whoami, usage, workspace
  detection, spawn, and pre-spawn setup all run **co-located with the agent** (local
  for local, on the remote-bridge for remote). Implemented as a shared
  **agent-adapter** contract that the remote-bridge hosts and seam-acp invokes over
  the command bus. *Consequence:* adapter code must be **shippable to the bridge** (a
  shared, version-negotiated contract). Accepted cost. *Note:* because every adapter
  runs co-located (D9 makes even `local` a loopback host), there is **no
  central-execution-against-remote-fs path** — so **no `Storage` abstraction is
  needed**; adapters use local fs directly (a thin fs seam is optional, for unit-test
  mocking only).
- **`[decided]` D4 — seam-acp owns the brain; each host owns the hands + keychain.**
  See §6 ownership table. seam-acp owns orchestration + adapter contracts; each host
  owns execution mechanics, **local secrets**, and storage. Secrets never traverse
  the wire or live in seam-acp.
- **`[decided]` D5 — Clean slate.** No active remote agent today → **delete** the
  `copilot-remote` machinery first (§9 phase 0). No migration burden.
- **`[decided]` D6 — Monorepo, standalone installable.** Adapters, seam-acp, and the
  remote-bridge live in **one repo** with workspace packages — `packages/adapters`,
  `packages/core` (seam-acp), `packages/bridge` — so adapters are maintained in **one
  place** and shared natively (no separate-repo submodule/subtree/CI-copy sync). The
  bridge is still shipped as a **lean standalone installable** (bundled binary /
  focused package depending only on `adapters` + transport, *not* on `core`'s
  Discord/orchestrator deps), preserving easy-install. Cross-host build skew is
  handled by the `protocolVersion` handshake (§5). *"Separate repo" was a proxy for
  "clean standalone installable" — we keep the installable, drop the separate source.
  Revisit only if the bridge needs independent/public distribution (see §12).*
- **`[decided]` D7 — Dev mode (unrestricted command tunnel).** A single `--dev` flag
  (off by default, **same bridge token** — no separate credential) turns the bus into
  an unrestricted `exec`/`shell`/`tailLog`/`writeFile` tunnel for that host, so
  cross-host debugging runs from one pane of glass (`/seam debug <bridge>`) instead of
  SSH-into-each-box. Deliberately minimal — no audit/scoping/expiry now; harden later
  (§6.1).
- **`[decided]` D8 — Per-bridge pairing.** seam-acp mints a per-bridge
  `{ bridgeId, token }` at pair time; you run a one-line bootstrap on the host once.
  Per-bridge, not one global token. Concrete flow in §6.2.
- **`[decided]` D9 — `local` is a loopback bridge.** Local agents go through the *same*
  adapter-over-bus interface via an in-process transport — one code path for
  local + remote, so dev mode (D7), reconciliation (§4.1), and diagnostics behave
  identically everywhere. `local` is just a host (with its own emoji).
- **`[decided]` D10 — Flattened, host-prefixed selection.** The picker lists **every**
  `agentId@location` as its own entry, prefixed by the host emoji (e.g. local=3, x=2,
  y=1 → **6 entries**: `🏠 …`, `🖥️x …`, `🖥️y …`). Rendered via the display resolver
  (host emoji + agent short — see [display-naming-plan.md](./display-naming-plan.md)).
  The per-thread `agentId@location` binding is persisted on the thread/session record.
- **`[decided]` D11 — One workspace root per host.** Each host exposes a single
  workspace root for now, declared in **bridge config** (alongside the host's
  emoji/short, D10/naming). `listWorkspaces()` enumerates under it, host-side (§7).

## 3. What we keep / change / delete

**Keep (already build-ready):**
- The resilient transport in `remote.ts` `makeMux`: slot multiplexing, instance-id
  restart eviction, `listSlots` recovery, queued-stdin-on-reconnect, SIGUSR2 drain.
- **ACP-transparency:** model-set, effort (`setSessionConfigOption`),
  `promptCapabilities` (vision), and thinking all flow over the ACP pipe — confirmed
  in `agent-runtime.ts` (`initResult.agentCapabilities`, `conn.setSessionConfigOption`,
  `_meta` in `session/new`). Bridged agents inherit these **for free**; the redesign
  does not re-plumb capabilities.
- Two transport modes: *server* (seam-acp hosts WS) and *client* (bridge hosts WS,
  e.g. via `cloudflared`).

**Change:**
- Generalize ad-hoc `cmd/cmd_reply` into a typed **command bus** (§5).
- Replace the copilot-shaped remote profile with the **agent-adapter** model (§4).

**Delete (phase 0):** `makeRemoteCopilotServerProfile/ClientProfile`,
`REMOTE_COPILOT_PROFILES`, the bridge's hard-coded `--session-type` copilot/claude
branches, and the `rewriteCwdInChunk`/`localCwd` path-rewrite hack (§7 removes the
need for it).

**Debt retired (a consequence of the above, not extra work).** Executing the plan
removes a whole cluster of existing debt for free: the claude/copilot **session-logic
duplication** (typed profiles *and* the untyped `.mjs` bridge → one co-located adapter,
D3), the **identity/location conflation** (D1/D9), the **cwd-rewrite hack** (§7), the
bridge's **raw-SQL/`sqlite3`-CLI** access (→ typed adapter), and the untyped `.mjs`
itself (→ TS, D6). Full register + the parts the plan does *not* touch:
[tech-debt-notes.md](./tech-debt-notes.md).

## 4. Agent-adapter contract

One interface, same whether it runs locally or on a bridge. seam-acp calls it
directly for local agents and over the command bus for remote ones.

```
interface AgentAdapter {
  agentId: string
  // capabilities & catalog
  describe(): { version, models?, effort?, promptCaps?, … }
  // lifecycle
  prepare(): Step[]            // idempotent startup/pre-spawn hooks (reconcile, §4.1)
  install(): InstallRecipe     // pinned, allow-listed (§6 security)
  spawn(cwd, opts): <ACP stdio>
  // workspace / cwd — runs at the host (§7)
  listWorkspaces(): Workspace[]
  // session management — runs at the host (D3)
  listSessions(cwd) / getTranscript / getUsage / cloneSession / deleteSession
  // identity — runs at the host
  whoami(): Identity | null
  usage(): UsageReport | null
  // host-side attachment I/O (§4.2)
  writeAttachment(cwd, filename, bytes)                          // seam-acp → host: stage a user-sent upload
  readAttachment(cwd, path): { bytes, filename, size } | null    // host → seam-acp: ferry a `seam-attach`-requested file
}
```

- **Local agents:** seam-acp loads the adapter in-process (today's
  `claude.ts`/`copilot.ts`/`agy.ts`/`opencode.ts` become adapters).
- **Remote agents:** the **remote-bridge hosts the same adapter** and seam-acp
  invokes its methods via `rpc` (§5). Existing per-agent logic is **reused**, not
  duplicated — this retires the bridge's hand-rolled claude/copilot session code.

### 4.1 Connection lifecycle & reconciliation (the startup-hook model)
1. remote-bridge connects, authenticates (§6), sends **`hello`** with its agent
   **inventory** (`agentId`, version, installed, ready).
2. seam-acp validates `protocolVersion`, registers the bridge + its agents
   (`agentId@bridgeId` become selectable).
3. seam-acp computes a **reconciliation plan** from each agent adapter's declared,
   **idempotent `prepare()` steps** and executes them over the bus (e.g. opencode's
   LM-Studio discovery + config-sync becomes *its* `prepare()`).
4. On success → agent marked **ready**. Missing agent → surfaced, with an optional
   **install** action (§6).
5. On disconnect → mark that bridge's agents unavailable + evict runtimes (existing
   instance-id logic). On reconnect → re-run idempotent reconcile.

### 4.2 Outbound file attachment — the `seam-attach` ferry
seam-acp ships an agent-agnostic file-attach convention: an agent emits a fenced
block tagged `seam-attach` whose body is a workspace file path, and seam-acp
uploads that file to the user (detected in `emitClosedFence`; the convention is
taught via the per-turn `<seam-harness>` preamble in `agent-conventions.ts`). For
a **local** agent the file is on the same host, so seam-acp reads it directly. For
a **remote** agent the fenced text arrives over the bus but **the file lives on the
bridge host** — the control plane can't read it. `readAttachment(cwd, path)` closes
that gap: on seeing a `seam-attach` fence from a remote agent, seam-acp calls it
over the bus; the **adapter resolves the path host-side** (project-cwd-relative
first, then the host's workspace root; realpath within-root check blocks `..`
escapes; honors the 25 MB attach cap) and returns the bytes, which seam-acp then
uploads. Same convention, same detection, same UX — only the file-read relocates
to the host (D3/D4). The teaching preamble is host-neutral, so remote agents
already know the convention the moment they're reachable; only the ferry is new.
Until PR3 lands, a `seam-attach` from a remote agent fails gracefully (seam-acp
posts a "couldn't read the file from the host" note) rather than misbehaving.

## 5. Command-bus protocol (v1 draft)

One persistent WebSocket per bridge (both server/client modes retained). All frames
JSON `{ v, type, … }`; `protocolVersion` negotiated in `hello`.

| Frame | Dir | Purpose |
|---|---|---|
| `hello` | bridge → acp | `{ bridgeId, instanceId, protocolVersion, host:{os,arch}, agents:[…] }` |
| `hello_ack` | acp → bridge | `{ protocolVersion, accepted }` |
| `data` / `kill` / `exit` | both | per-session ACP stdio (existing slot mux — unchanged) |
| `rpc` | acp → bridge | `{ id, agentId, method, params }` — invoke an adapter method |
| `rpc_reply` | bridge → acp | `{ id, ok, result? | error? }` |
| `event` | bridge → acp | unsolicited (install progress, agent crash, prepare status) |
| `ping` / `pong` | both | keepalive (existing) |

- `rpc.method` ∈ the **adapter method allow-list** only (§4) — there is **no generic
  shell / read-arbitrary-file primitive** (security, §6). `readAttachment` (§4.2)
  is **not** an exception: it is allow-listed, **scoped to the host's workspace
  root**, and carries the same within-root + 25 MB guards as the local path — a
  narrow attachment ferry, not a general file read.
- `readAttachment` returns file **bytes** over the bus — base64 in the `rpc_reply`,
  or chunked `event` frames for large files (`[research]` chunk threshold; the
  25 MB attach cap bounds it either way).
- Versioning: `hello` negotiates `protocolVersion`; mismatches degrade gracefully or
  refuse with a clear message. `[research]` exact negotiation rules.

## 6. Security model

- **Auth:** **per-bridge** credential (not one shared global token) issued at
  **pair time**; sent over **`wss`/TLS**; **rotatable**; never logged. (The old
  single token once leaked in cleartext — don't repeat that.)
- **Transport:** TLS always. Client-mode via `cloudflared` gets TLS from the tunnel;
  still enforce the app-layer token.
- **Authorization scoping:** the `rpc` surface is a **fixed, typed allow-list of
  adapter methods** — *this is the core security win of the co-located-adapter model
  over a generic remote-fs RPC.* No "run shell," no "read any path."
- **Install guardrails:** `install(agentId)` runs a **pinned, adapter-declared**
  recipe from an allow-list; **explicit Discord confirmation** required; progress
  **streamed** via `event`; seam-acp never sends arbitrary commands.
- **Secrets:** **stay host-local** (each bridge's keychain / env / agent config
  dirs). seam-acp neither transmits nor stores remote credentials. (Matches D3:
  whoami/usage already run at the agent and need local creds.)
- **Blast radius:** a compromised seam-acp can *drive* remote agents (inherent — it's
  the control plane) but cannot exfiltrate raw files/secrets beyond what typed
  adapter methods expose; a compromised bridge exposes only its own host.

### 6.1 Dev mode (D7)

Cross-host debugging shouldn't mean SSHing into each box. **Dev mode** is a single
switch that turns the command bus into an **unrestricted tunnel** for that host.

- **One flag.** `--dev` / `SEAM_BRIDGE_DEV=1` (off by default) enables
  `exec`/`shell`/`tailLog`/`writeFile` over the bus. Off → those handlers aren't
  registered.
- **Same token.** Authenticated by the **existing bridge token** — no separate
  credential, no extra ceremony.
- **No auto-expiry, no elevation gating.** Intentionally minimal; the project
  primarily serves a single operator right now.
- **Driven from the control plane:** `/seam debug <bridge>` (tail / exec / status) and
  agent-callable — one pane of glass, no per-machine buffering.

**Honest framing:** dev-mode `exec` is full RCE on that host — but it **replaces**
SSH-to-every-box (same power, just made ergonomic), so it's not *new* risk.

**Deferred hardening (later, not now):** a read-only-by-default observability subset,
a separate dev token, an audit log, path scoping, auto-expiry. Cut intentionally to
avoid bloat — revisit if the project grows beyond a single operator.

### 6.2 Pairing flow (D8)

1. **`/seam bridge add <name>`** on seam-acp → mints `{ bridgeId, token }`, records the
   transport mode + URL, and prints a one-line bootstrap, e.g.
   `seam-bridge connect --server <wss-url> --id <bridgeId> --token <token>`.
2. **Run the one-liner on the host.** The bridge stores the credential locally and
   dials in (server mode) — or `seam-bridge serve` + hand seam-acp the tunnel URL
   (client mode).
3. **seam-acp validates** the token (sent in the WS auth header, same mechanism as
   today) against what it issued → marks the bridge **paired**.
4. **Rotation:** `/seam bridge rotate <name>` issues a new token, pushed over the
   already-authenticated channel (or re-bootstrap).

No PKI; reuses the current token-in-header auth. The only new pieces are seam-acp
minting/storing per-bridge creds and the `/seam bridge add|rotate` UX.

## 7. Workspace / cwd model

- **Detection runs at the agent.** The repo/cwd picker calls the adapter's
  `listWorkspaces()` **on the host** (over the bus when remote); seam-acp shows
  whatever that host reports.
- seam-acp then uses the **host-reported absolute paths natively** in prompts and
  session ops. **No path translation** — which **deletes the current
  `rewriteCwdInChunk`/`localCwd` hack** entirely.
- `[research]` Base-path config per bridge (which roots a host exposes) + how
  `listWorkspaces` enumerates them (mirror seam-acp's `REPOS_ROOT` scan, host-side).

## 8. Ownership (D4 detail)

| Dimension | Owner | Why |
|---|---|---|
| Orchestration (what runs, when) | **seam-acp** | single brain |
| Agent contracts (adapter interface) | **seam-acp** | one consistent catalog |
| Availability (which agents installed) | bridge **reports** → seam-acp reacts | only the host knows |
| Execution mechanics (spawn/setup) | **adapter, at host** | runs where the agent lives (D3) |
| Secrets / credentials | **host-local** | agent + whoami + usage run there |
| Session storage | **host-local (the agent)** | D3 |

**Rejected alternative — seam-acp owns secrets too (push per spawn):** central mgmt,
but creds cross the wire every spawn, seam-acp becomes a multi-machine secret vault
(big blast radius), and it duplicates the local creds whoami/usage already require.
Not worth it.

## 9. Build sequence (each PR is safe + value-preserving)

> **Keystone:** PR1 *ratifies* the §4 agent-adapter contract by implementing it four
> times — producing the interface and starting the build are the same step.

- **PR0 — Subtract.** Delete the `copilot-remote` machinery (D5):
  `REMOTE_COPILOT_PROFILES`, `makeRemoteCopilot*`, the bridge `--session-type`
  branches, the `rewriteCwdInChunk`/`localCwd` hack. Nothing uses it now — pure
  cleanup.
- **PR1 — Adapter refactor (in-place, behavior-preserving).** Recast
  `claude/copilot/agy/opencode` as the `AgentAdapter` contract (§4), still running
  locally in-process. App behaves identically. **No bridge yet** — lowest-risk
  foundation; this is where the contract is ratified.
- **PR2 — Monorepo (D6).** Restructure into `packages/{adapters,core,bridge}`; extract
  `makeMux`/transport into the shared module; build the bridge as a lean standalone
  installable.
- **PR3 — The bridge.** Command bus (§5) + reconciliation handshake (§4.1) + per-bridge
  pairing (D8/§6.2) + dev mode (D7/§6.1) + `install()` (§6) + the `readAttachment`
  **`seam-attach` ferry** (§4.2), so the already-shipped file-attach convention works
  for remote agents (file on the host) and not just local ones.
- **PR4 — Location binding.** D9 loopback + D10 flattened/host-prefixed selection +
  per-thread `agentId@location` persistence + workspace-at-host (D11/§7).

**Parallel, anytime:** the display-naming standard
([display-naming-plan.md](./display-naming-plan.md)) isn't gated by any of this and
improves the app today — landing `resolveDisplay` to retire
`threadAbbr`/`REPO_EMOJIS`/hand-baked emoji is a standalone win.

**Debt discipline (executed *within* the PRs above — full register:
[tech-debt-notes.md](./tech-debt-notes.md)):**
- **PR1:** tighten the `as any` parse-boundary types in the four profiles while you're
  rewriting them (C3).
- **PR3/PR4:** introduce bridge config as a **structured file**, not more `REMOTE_*`-style
  env parsing — keeps `config.ts` from growing (C2); and **extract** the new
  `/seam bridge`, `/seam debug`, and selection UI into their *own* orchestrator modules
  rather than growing the 5.9k-LOC `orchestrator.ts` (A1 — *targeted only*; a full
  decomposition is a separate project, out of scope here).
- **Parallel:** the naming resolver (D10) retires the
  `threadAbbr`/`REPO_EMOJIS`/hand-baked-emoji sprawl.

## 10. Rollout & session continuity

Built incrementally so daily use is never disrupted. The work runs on a feature branch
in a **separate git worktree** (`git worktree add ../seam-bridge-dev …`) — production
keeps serving `main` from `dist/`, untouched, until each PR is verified and merged.
Each PR is one restart, deployed in a quiet window.

**Per-stage rollback (rule).** Every completion stage **outputs its rollback command**
on deploy — pre-staged, not improvised: capture the prior-good SHA *before* merging,
and record `git checkout <prev-good-sha> && npm run redeploy` alongside the deploy.
(Proven 2026-06-05: a revert+redeploy during the auth scare took ~1 min.) Keep PRs
small so each rollback is clean and single-step.

**The only disruption you feel:** a redeploy restart kills an *in-flight* turn — resend
that one message. Everything else survives: thread→session mapping (`seam.db`),
history, and **auto-resume on the next message**. `/seam sessions` re-attach is the
*safety net* for a rare wedged thread, not a routine step.

**Two hard rules → no history loss / no forced re-attach:**
1. **PR1 preserves on-disk session formats + the `seam.db` schema** (Claude JSONL stays
   JSONL, Copilot SQLite stays as-is) — existing threads stay readable.
2. **PR4's `agentId@location` binding is an *additive* migration** — a nullable column
   defaulting to `local`; existing threads are implicitly `@local`, untouched.

**Per-PR user impact:**
| PR | User-facing change | Risk |
|---|---|---|
| PR0 delete dead remote code | none (already unused) | ~zero |
| PR1 adapters (in-place) | none — identical behavior | low — verify all 4 agents |
| PR2 monorepo restructure | none — build-only | low |
| PR3 the bridge | additive (new capability) | isolated (opt-in) |
| PR4 location binding | additive + opt-in | isolated |

**Opt-in coexistence (the big de-risker):** the bridge is additive — until you pair a
bridge and bind a thread to `@<bridge>`, nothing about local workflow changes. Old and
new paths run side by side; you move threads over one at a time, on your schedule.

## 11. Preserve (regression tests)
Instance-id eviction · SIGUSR2 drain · `listSlots` recovery · queued-stdin-on-
reconnect · ACP-transparency of model/effort/caps/thinking. Pin these as conformance
tests in `seam-bridge`.

## 12. Deferred (settle when building the relevant piece — none block starting)
- `[deferred]` `protocolVersion` negotiation + tolerated adapter-contract skew →
  settle when writing the handshake (§4.1 / §5), during PR3.
- `[deferred]` Install-recipe format + provenance/pinning → settle when building
  `install()` (PR3).
- `[idea]` Independent/public bridge distribution — the trigger to revisit **D6**
  (monorepo); would move adapters+bridge into a shared lower package seam-acp depends
  on.
- `[ref]` Display / short-name standard (host emoji, cwd names) is specced separately:
  [display-naming-plan.md](./display-naming-plan.md).

## 13. Related
- Debt assessment + how this plan intersects it (and what it does *not* touch):
  [tech-debt-notes.md](./tech-debt-notes.md).
- Current implementation: `src/agents/profiles/remote.ts`,
  `scripts/remote-agent-bridge.mjs`, consumed in `src/agents/agent-runtime.ts`.
- The browser-automation substrate in [integrations-research.md](./integrations-research.md)
  could run *as an agent on a bridge host* — the two roadmaps compose.

---

## 14. Amendment — 2026-08-18 vetting against current code

The original body (§0–§13) is preserved as written on 6/05. This amendment records
what changed in seam-acp since then and how it modifies the plan. **§14.0** is cosmetic
(fold into PR0/PR1 with no design change). **§14.1–14.4** are substantive and each is
scoped to become its own GitHub issue.

### 14.0 — Cosmetic refreshes (no design change; fold into PR0/PR1)  → **#82**

- **Agent roster: 4 → 6.** PR1 recasts not just claude/copilot/agy/opencode but also
  **codex** and **grok** (registered in `index.ts`), plus the claude-vertex /
  ollama-cloud variants. The adapter contract (§4) is unchanged; there are just more
  implementers. `grok`'s `effort` descriptor also gained a **`spawnArgs`** mechanism
  (CLI `--reasoning-effort` at spawn) — one more `mechanism` value the adapter's
  `describe()` must round-trip.
- **`orchestrator.ts` is now ~11k LOC (was 5.9k).** The §9 debt note (A1) about
  extracting `/seam bridge`, `/seam debug`, and selection UI into their own modules is
  no longer optional politeness — it is a **hard prerequisite** for landing the bridge
  UI without making the file unmaintainable.
- **Dev-loop note is stale.** The "~4 known pre-existing `thread-rename` failures,
  ignore them" caveat is obsolete — the suite is fully green (700+ passing). Remove it.
- **UI anchors moved by #78.** `/seam sessions` is now **`/seam info sessions`**; the
  model/effort/agent/etc. pickers and config commands live under the new **`config`**
  subcommand group. Any §-body reference to `/seam sessions` or a flat config command
  should be re-anchored. `npm run patch-acp` is already retired (accurate as written).

### 14.1 — Security must compose with the config-mutation tiers (#58/#71/#74)  → **#83**  [amends §6, §6.1, D7, D8]

**Problem.** §6.1/D7 assume *"a single operator, no elevation gating, the same bridge
token."* That premise is void: seam-acp now has **three tiers** — admin
(`SEAM_CONFIG_ADMIN_USER_IDS`) > participant (`SEAM_PARTICIPANT_USER_IDS`, e.g. the
student accounts) > operator (plain `DISCORD_ALLOWED_USER_IDS`) — enforced on **every**
`/seam` subcommand via `isParticipantSlashRefused` + `isLockedSlashRefused`
(orchestrator.ts). A `/seam bridge`/`/seam debug` command therefore inherits gating for
free, but the **default gate only refuses participants** — it would still let a
non-admin operator pair a bridge or open a dev-mode RCE tunnel.

**Decisions.**
- **D7-rev / D8-rev — admin-only, not merely non-participant.** `/seam bridge add|rotate`
  and `/seam debug <bridge>` (dev-mode `exec`/`shell`/`writeFile`/`tailLog`) MUST require
  the invoker's harness-stamped id ∈ `SEAM_CONFIG_ADMIN_USER_IDS`. Reuse the #71 admin
  predicate; do **not** add these to `LOCK_EXEMPT_SUBCOMMANDS` or
  `PARTICIPANT_ALLOWED_SUBCOMMANDS`. Result: admin-immune in locked channels, refused
  for everyone else — the same posture `/seam config detach` (#80) landed with.
- **Audit the control surface.** Every pair / rotate / dev-mode-enable writes a
  `config_audit` row (#70): actor id+name, bridgeId, action. Dev-mode RCE especially
  needs a trail now that it isn't a single-operator box.
- **Dev-mode double-gate.** Keep `--dev` off-by-default on the bridge *and* require the
  admin gate control-plane-side even when the flag is on. `SEAM_BRIDGE_DEV=1` alone must
  not open the tunnel to a non-admin.

**Acceptance.** A participant or non-admin operator is refused pair/rotate/debug; an
admin succeeds; each action writes an audit row; refusals log the resolved speaker id;
with `SPEAKER_IDENTITY_ENABLED=false` the admin gate fails closed (no bridge ops), same
rule as #71.

**Slots into:** PR3 (pairing + dev-mode) — this is a hard requirement, not a follow-up.

### 14.2 — seam-MCP interplay  → **#84**  [new section, touches PR3/PR4]

**Problem.** The entire agent-facing orchestration surface postdates the plan and is
unmentioned: `handoff` / `forward` / `steer` / `dispatch` / `chain` / `send` / `poll_inbox`
/ `interrupt` / `peek` / `threads` / `config_propose` / `schedule_wake` / `watch_*`
(seam-mcp-server.ts). Bridged agents must interoperate with it.

**Decisions / scope.**
- **Control-plane tools compose for free — but verify the token reaches the host.** A
  bridged agent's `handoff`/`steer`/etc. route back through seam-acp; the per-session
  `X-Seam-Session` token is minted regardless of location. PR3 must ensure that token is
  injected into the **remote** agent's spawn env (adapter `spawn(cwd, opts)` carries it)
  so the remote agent can reach the seam-MCP server over the wire the same as a local one.
- **Workers-on-bridges (the synergy worth naming).** Dispatch/handoff targets can be
  `agentId@location` — a stateless preset worker or the 🚾 dispatch pool could run on a
  remote host (e.g. a Mac). Decide: does a `DispatchSpec` carry a `location`, and does the
  DispatchWatcher route a spec to a bridge adapter's `spawn` instead of a local runtime?
- **`threads()` (#73) becomes location-aware.** It must list `agentId@location` sessions
  with their host emoji and a `busy` derived across the bus (the runtime lives on the
  bridge). Cross-host discovery is otherwise a dead end for delegation.
- **Reuse config persistence.** `config_propose { threadPreset }` (#68) and `/seam config
  detach` (#80) already write `channel-presets.json`; D10's per-thread `agentId@location`
  binding and D11's bridge config should live in the **same** store + write path (§14.4),
  not a parallel one.

**Acceptance.** A remote-bridged session is addressable by `handoff`/`steer`/`threads`;
a worker can be dispatched to a bridge host and reports back; the seam-MCP token resolves
from inside a remote agent.

**Slots into:** PR3 (token reach) + PR4 (location-aware dispatch/threads).

### 14.3 — Turn-resume (#75/#76) × D2/D3/§10  → **#85**  [amends §10, touches §4.1, PR4]

**Problem.** When the plan was written, "auto-resume on the next message" (§10) was a
property, not a subsystem. It now is one: durable turn markers, persisted
`acp_session_id` per dispatch (#75), boot reconciliation to an `interrupted` status, and
an auto-resume loop that injects `"continue"` + `loadSession` (#76, flag-gated,
staggered, max-age-bounded). A **remote-bridged** interrupted turn cannot resume until
its bridge reconnects.

**Decisions.**
- **Resume gates on bridge availability.** A resume marker whose session is `@<bridge>`
  must be **deferred** until that bridge's reconciliation handshake (§4.1) completes and
  the agent is marked ready — then resumed. If the bridge never returns within the resume
  max-age window (`SEAM_TURN_RESUME_MAX_AGE_SECONDS`), **abandon** with a notice, mirroring
  the deleted-thread precondition already in #76.
- **D2/D3 make the host non-negotiable.** The session's storage is pinned to the host
  (D2) and `loadSession` runs agent-local (D3), so a resume MUST reattach on the **same**
  bridge — never re-dispatch a `@mac` session to `@local`. #75's `acp_session_id` is the
  pointer; the location binding (§14.4 / D10) is the host selector.
- **Reconciliation emits a "bridge ready" event the resume loop subscribes to** (§4.1
  already fires `event` frames — add/[reuse] a ready signal so recovery is event-driven,
  not polled).

**Acceptance.** A reboot mid-remote-turn resumes after the bridge reconnects; abandons
past max-age with a notice; never resumes on the wrong host; a local turn's resume is
unchanged.

**Slots into:** PR4 (needs the location binding first) + a §10 rollout note.

### 14.4 — Command tree + persistence reuse (#78/#68/#70/#80)  → **#86**  [amends §7, §9, D10, D11]

**Problem.** The plan predates both the #78 command tree and the config-mutation /
thread-preset / audit machinery, so it under-specifies where bridge UI and config live.

**Decisions.**
- **`/seam bridge` and `/seam debug` are subcommand GROUPS**, not top-level commands —
  following the `config` group precedent from #78. There are ~15 free top-level slots, so
  room is not the constraint; consistency is. (`bridge add|rotate|list|remove`;
  `debug tail|exec|status`.)
- **Bridge config is structured config reusing the existing pattern**, not new `REMOTE_*`
  env parsing (the plan already wanted this in §7/`[research]`; now there is a concrete
  home). Per-host emoji/short-name/workspace-root (D11) and the per-thread
  `agentId@location` binding (D10) should be persisted through the **same
  `channel-presets.json` + config-mutation + `config_audit` path** that #68/#80 write,
  and hot-reload the same way — so `/seam config` describe/audit sees bridge/location
  state too.
- **The §9 A1 extraction is a hard prerequisite** (see §14.0): stand up
  `orchestrator/bridge.ts` + `orchestrator/debug.ts` rather than growing the 11k-LOC file.

**Acceptance.** `/seam bridge` + `/seam debug` register as groups within budget; bridge
config round-trips through the presets file with a schema + audit row; a thread's
`@location` binding is an additive nullable field defaulting to `local` (matches D10 /
§10 rule 2); the new UI lives in its own module(s).

**Slots into:** PR3 (bridge/debug groups + config) + PR4 (per-thread binding) + the §9
debt discipline.

### 14.5 — Net

No rewrite: PR0 (subtract) and PR1 (adapter refactor) are unchanged and remain the right
start. The amendments concentrate in **PR3** (security tiers 14.1, seam-MCP token 14.2,
bridge/debug groups 14.4) and **PR4** (location-aware dispatch/threads 14.2, resume 14.3,
per-thread binding 14.4). Recommended issue set: one per §14.1–14.4, plus a small 14.0
"doc/anchor refresh" chore folded into PR1.
