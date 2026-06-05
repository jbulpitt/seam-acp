# Seam Bridge — generalized machine-to-machine agent conduit

**Status:** draft spec (core decisions recorded) · **Created:** 2026-06-05 ·
**Updated:** 2026-06-05 · **Owner:** jbulpitt

Reframe the "remote agent" from a bespoke *agent type* into a generic *transport +
command bus* so any agent (claude, copilot, agy, opencode, …) can run on any number
of other machines, selected as configuration rather than as separate picker
entries.

> **Legend** — `[idea]` · `[research]` · `[decided]` · `[blocked]` · `[done]`.

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
  shared, version-negotiated contract). Accepted cost.
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
  Revisit only if the bridge needs independent/public distribution (see §11).*
- **`[decided]` D7 — Dev mode (unrestricted command tunnel).** A single `--dev` flag
  (off by default, **same bridge token** — no separate credential) turns the bus into
  an unrestricted `exec`/`shell`/`tailLog`/`writeFile` tunnel for that host, so
  cross-host debugging runs from one pane of glass (`/seam debug <bridge>`) instead of
  SSH-into-each-box. Deliberately minimal — no audit/scoping/expiry now; harden later
  (§6.1).
- **`[decided]` D8 — Per-bridge pairing.** seam-acp generates a per-bridge
  `{ bridgeId, token }` at pair time; paste it into the bridge once. Per-bridge, not
  one global token. (The pairing *handshake* wire-flow is still to spec — §11.)
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
  // restricted-host attachment write
  writeAttachment(cwd, filename, bytes)
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
  shell / read-arbitrary-file primitive** (security, §6).
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

## 9. Phasing (updated)

0. **Delete** the `copilot-remote` machinery (D5 clean slate).
1. **Adapter refactor.** Recast `claude/copilot/agy/opencode` profiles as
   `AgentAdapter`s (§4); seam-acp loads them locally. Behavior-preserving.
2. **Set up the monorepo + bridge artifact (D6).** Restructure into workspace
   packages (`adapters`/`core`/`bridge`); pull `makeMux`/transport into the shared
   module; build the bridge as a lean standalone installable (adapter-host + command
   bus).
3. **Command bus (§5)** + **reconciliation handshake (§4.1)**.
4. **Location binding (D1/D2)** — `agentId@location`, picker "pick agent → pick
   where," sessions pinned.
5. **Capability discovery + graceful errors + guarded install (§6).**
6. **Workspace-at-host (§7)**; remove the cwd-rewrite hack.

## 10. Preserve (regression tests)
Instance-id eviction · SIGUSR2 drain · `listSlots` recovery · queued-stdin-on-
reconnect · ACP-transparency of model/effort/caps/thinking. Pin these as conformance
tests in `seam-bridge`.

## 11. Still open
- `[research]` `protocolVersion` negotiation + how much adapter-contract version skew
  between seam-acp and a bridge is tolerated.
- `[research]` Install-recipe format + provenance/pinning.
- `[research]` Pairing **handshake** wire-flow (D8 fixed the model — per-bridge
  `{bridgeId, token}` — but not how the credential is delivered/exchanged).
- `[research]` Whether to build the **D3 `Storage` seam** up front (lets an adapter
  run centrally) or run adapters at-host first and retrofit it.
- `[idea]` Independent/public bridge distribution — trigger to revisit **D6**
  (monorepo); would move adapters+bridge into a shared lower package seam-acp depends
  on.
- `[ref]` Display / short-name standard (host emoji, cwd names) is specced separately:
  [display-naming-plan.md](./display-naming-plan.md).

## 12. Related
- Current implementation: `src/agents/profiles/remote.ts`,
  `scripts/remote-agent-bridge.mjs`, consumed in `src/agents/agent-runtime.ts`.
- The browser-automation substrate in [integrations-research.md](./integrations-research.md)
  could run *as an agent on a bridge host* — the two roadmaps compose.
