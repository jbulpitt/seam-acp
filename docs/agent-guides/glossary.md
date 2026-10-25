# Seam glossary

Current meanings of names used in Seam's tools, guides and source. Several are
overloaded; qualify the sense when it matters. This documents the glossary
slice of [#813](https://github.com/jbulpitt/seam-acp/issues/813), not its proposed
identity fields or symbol renames. Existing identifiers and behavior remain.

## Agent identity

- **Agent:** the ACP program selected by an `agentId`, such as `claude` or
  `codex`. Today's selector can bundle a CLI, backend and credential context;
  it does not identify just a model or provider.
- **Harness:** the CLI/client that runs the agent's tool and conversation loop,
  directly speaking ACP or using an ACP wrapper. Claude Code and Codex are
  harnesses. Separately, the **Seam harness preamble** (`<seam-harness>`) is
  metadata supplied with a turn, not another agent CLI.
- **Provider:** the service/backend serving model requests. A harness can use
  different providers: the `ollama-cloud` profile uses the Codex harness.
- **Account:** the credential context under which requests run. This is separate
  from the Discord author, execution host and model. Some profiles locate it
  through a separate `configDir`.
- **Agent profile:** the current `AgentAdapter` configuration/behavior contract;
  `AgentProfile` is its type alias. It supplies identity, spawning, catalog and
  agent-specific behavior. A catalog's `credentialProfile` instead scopes model
  evidence to a credential context. Neither means a reusable worker preset.

The present interface does not declare a unified `harness` / `provider` /
`account` tuple. Card `brand` names the service; warm-set `AgentFamily` groups
resource estimates. Neither is a complete identity model. Those distinctions
exist across [agent profiles][profile], [catalog scope][catalog] and
[warm-set families][family]; #813's proposal to unify them is future work.

## Hosts and routing

- **Host:** a machine on which agent processes run.
- **Bridge:** the per-host process/connection advertising adapters and routing
  operations between the controller and that host's sessiond.
- **Location:** the routing key in `agentId@location`: `local` or a bridge id.
  It is not a provider, account or working directory.
- **Local:** the controller host's bridge, not necessarily the machine running
  your shell or this worker. Local execution still goes through a bridge and
  sessiond. Omitted-host defaults depend on the operation: for example,
  `configure_thread` with a bare agent keeps the thread's current host.

See the [deployment layers][deploying], [location binding][location] and
[thread configuration tools][mcp].

## Conversations and processes

- **Seam session:** the durable binding/configuration for a chat thread,
  represented by `SessionRecord` (`platform:channel_ref`). It records the
  selected agent and an `acpSessionId`; it is not an agent process.
- **ACP session:** the conversation opened or loaded through the agent's ACP
  endpoint. Its id belongs to that endpoint, not to the Discord thread or slot.
- **Provider conversation / native session:** the history maintained by the
  harness/provider, such as a native transcript or server-side conversation.
  Its relationship to an ACP session depends on the adapter; do not assume all
  these ids are interchangeable.
- **Sessiond:** the host daemon owning supervised agent processes and retained
  output, so controller/bridge reconnections can reattach to running work.
- **Slot:** a numbered supervised endpoint for an adapter-child and its output.
  A slot id is neither a Seam session id nor an ACP conversation id.
- **Runtime:** qualify this name. Core `AgentRuntime` manages the ACP connection
  and turns; an adapter's **runtime descriptor** describes launch facts such as
  executable, arguments and provenance. Neither is the durable thread record.

Authorities: [session records][types], [native history access][sessions],
[AgentRuntime][runtime], [supervised slots][slots] and
[recovery ownership][recovery]. A retained or “stalled” attempt is not itself a
host-health verdict or a blocker. `threads()` exposes `busy` and observed
`workProgress` separately, including bridge-owned recovery; read those current
fields rather than inferring execution from the label alone.

## Adapter senses

- **Agent adapter/profile:** the `AgentAdapter` contract described above.
- **ACP adapter/wrapper:** software such as `codex-acp` translating between a
  native CLI and ACP. Wrapper and native CLI versions are separate facts.
- **Adapter-child:** the [host process][child] between sessiond and the agent,
  handling bootstrap and the agent's protocol path.
- **Chat/platform adapter:** the [ChatAdapter][chat] interface and its platform
  implementations, such as Discord message/card delivery. This is a different
  layer from an agent adapter.

## Preset senses

- **Named worker preset:** a reusable, project-scoped or global bundle of
  agent/model/effort/cwd/instructions and other settings. `/seam preset apply`
  applies it; `/seam preset thread` creates a thread from it. A handoff to its
  name starts a fresh specialist, not that previously created thread.
- **Channel/thread preset:** inherited channel defaults or a thread overlay in
  the presets configuration file. These configure persistent threads; they are
  distinct from named worker bundles.
- **Ingest preset:** an HTTP ingest endpoint's reference to a named worker
  preset, resolved for incoming jobs. It is not a new kind of account.
- **Bridge preset/config:** the same configuration file's host metadata and
  transport/pairing settings, not a worker persona.

See [named preset records][types], [preset commands][preset-commands],
[configuration schemas][config] and [HTTP ingest][ingest].

## Cards

- **Turn status card:** progress for one prompt/dispatch: Waiting before
  admission, Working while executing, then its terminal result. It is not a
  provider-health or quota reading.
- **Server-status card:** controller and bridge/host status.
- **Service-status card:** upstream service status, distinguishing the
  provider's report from Seam's ability to observe it.
- **Quota card:** account usage/headroom, distinct from a turn's token usage or
  model context capacity.
- **Choice card:** a frozen structured question whose selection dispatches a
  prompt. Destinations are `live` (this thread), `thread` (another live thread)
  or `isolated` (a fresh session whose output appears in the card's thread).
- **Configuration proposal card:** a proposed settings diff with an Apply
  action. **Result card** means output presentation, not a session mode; an
  isolated specialist can update a card in a persistent thread.

See [turn states][types], [server status][server-card], [service status][service],
[quota rendering][quota] and [interactive choices][choices].

## Dispatch and delivery

These are **seam-MCP verbs**; similarly named slash commands can have different
options. **Live** means using a thread's existing session/context. **Isolated**
means a fresh task session, without adopting that thread's conversation.
**Report-back** means delivering completion as a new live turn to the return
thread, except the inline specialist result described below. Worker returns
to that same worker do not enqueue a self-report. Output streaming and
`stream:false` concern presentation, not live/isolated context.

- **`handoff`:** assigns work. A thread target wakes/queues a live turn; a named
  preset or agent target runs isolated. Thread-worker results report back to
  the caller by default (`returnTo` redirects; `reportBack:false` suppresses
  that delivery). A stateless specialist's default same-caller result is
  inline in its card, without a second caller turn; a different `returnTo`
  receives a live report-back.
- **`forward`:** relays content to another thread as a live turn, without
  specialist framing. It wakes/queues work and reports back to the caller by
  default; `reportBack:false` suppresses that return delivery.
- **`send`:** by default leaves a pull-only inbox message. It neither wakes an
  idle thread nor queues a turn or automatic report-back. `priority:true`
  changes how the note is presented at `poll_inbox`, not that delivery mode.
  With `interrupt:true`, it instead queues the next live turn ahead of pending
  dispatches, preserves running work and reports back to the caller.
  `fresh:true` resets context only when that directive starts.
- **`steer`:** queues a separate live course-correction turn after running and
  already queued work, with automatic report-back. It preserves context; it
  does not inject instructions into or cancel the active turn.
- **`chain`:** runs workers sequentially, feeding each output to the next.
  Thread hops are live; preset/agent hops are isolated. Hops do not each report
  back. Final output (or the broken hop's error/partial output) becomes a live
  turn in `returnTo`, the caller by default.
- **`schedule_wake`:** schedules one durable future live turn in your own
  thread, or on the next controller boot with `onStartup:true`. It queues
  behind busy work, preserves context and does not repeat automatically. It
  is self-reentry, not a worker with a separate report-back. A recurring
  **scheduled prompt** is different and defaults to isolated execution.

Exact arguments and routing: [MCP tools][mcp], [dispatch modes/results][dispatch]
and [orchestrator delivery][orchestrator]. See [wake events][wakes] for one-shot
wakes and [scheduled prompt modes][schedules] for recurring jobs.

[profile]: ../../packages/adapters/src/agent-profile.ts
[catalog]: ../../packages/adapters/src/model-catalog.ts
[family]: ../../packages/core/src/core/warm-set/footprint.ts
[deploying]: deploying.md
[location]: ../../packages/core/src/core/location.ts
[mcp]: ../../packages/core/src/core/mcp/seam-mcp-server.ts
[types]: ../../packages/core/src/core/types.ts
[sessions]: ../../packages/adapters/src/session-manager.ts
[runtime]: ../../packages/core/src/agents/agent-runtime.ts
[slots]: ../../packages/bridge/src/supervised-slots.ts
[recovery]: dispatch-recovery-authority.md
[child]: ../../packages/bridge/src/adapter-child.ts
[chat]: ../../packages/core/src/platforms/chat-adapter.ts
[preset-commands]: ../../packages/core/src/plugins/presets/commands.ts
[config]: ../../packages/core/src/config.ts
[ingest]: interactive-ingest.md
[server-card]: ../../packages/core/src/core/server-status-card.ts
[service]: service-status.md
[quota]: ../../packages/core/src/core/quota/agent-quota-card.ts
[choices]: interactive-prompts.md
[dispatch]: ../../packages/core/src/core/dispatch/types.ts
[orchestrator]: ../../packages/core/src/platforms/discord/orchestrator.ts
[wakes]: wake-events.md
[schedules]: ../../packages/core/src/core/scheduled-prompts/types.ts
