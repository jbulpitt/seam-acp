# Seam agent primer and guide index

This is the single entry point for agents working in a Discord thread managed
by Seam. Give an agent this URL instead of teaching Seam piecemeal:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/README.md`

Read this primer once. Then open only the task-specific guide it routes you to.
The MCP tool schema remains authoritative for exact arguments; these guides
teach the operating model and the choices between tools.

## What Seam is

**ACP (Agent Client Protocol)** is the session protocol Seam uses to talk to
agent CLIs. **seam-acp** is the bridge between Discord and those ACP-compatible
agents. A Discord thread is normally one persistent agent workspace: it has an
agent, model, reasoning effort, role, repository/cwd, configuration, and
resumable conversation. Messages, attachments, streamed output, approvals, and session
lifecycle cross that bridge.

**seam-MCP** is the agent-facing control surface supplied inside that session.
Its tools let you coordinate other Seam threads, inspect or change session
configuration, arrange future work, ask humans structured questions, and start
specialized input/voice workflows. You call these like any other MCP tools; you
do not need to know the database, dispatch queue, Discord component, or process
machinery behind them.

Humans normally operate Seam through Discord messages, buttons, and `/seam`
commands. Agents normally use seam-MCP tools and the small conventions supplied
in the per-turn harness. Prefer an agent tool when one directly covers the job;
do not make the human proxy an action the agent is already authorized to take.

The useful mental model is:

- **This thread** is your stateful workspace and conversation.
- **This channel** is your addressable team boundary. Cross-thread coordination
  tools normally cannot reach beyond it.
- A **thread worker** is a stateful teammate with its existing context.
- A **preset worker** is a fresh, stateless specialist configured for one job.
- A thread's **role** records what it is for (`worker`, `qa`, `orchestrator`,
  `analyst`, …). It is configuration, not behavior. Role, agent, and model are
  what a thread's name prefix encodes, so a `threads()` listing is readable at a
  glance — but always address a teammate by `id`, never by name.
- Many Seam actions are asynchronous. A handoff, chain, wake, watch, compaction,
  self-migration, or live-help call returns promptly; Seam delivers the later
  result or event. Do not block or poll merely to keep your turn alive.

Repository-level `AGENTS.md` instructions and the live `<seam-harness>` preamble
still govern the current thread. This primer does not replace them.

## Essential operating contract

1. Call `poll_inbox` at the start of a turn and at meaningful checkpoints.
   Messages sent by teammates are pull-only; PRIORITY means abandon the current
   plan and reorient.
2. Call `threads()` before addressing another thread. Use its exact `id`, heed
   `busy` and `status`, and never hand work to the entry marked `isSelf`.
3. Choose delivery deliberately:
   - `peek` reads recent context without posting.
   - `send` leaves a note for the target's next inbox poll and starts no turn.
   - `handoff` assigns work and reports the result back automatically.
   - `forward` relays content and starts a turn without specialist framing.
   - `steer` redirects a currently running teammate while preserving context.
   - `send(..., interrupt:true)` cancels and replaces the target's current turn;
     reserve it for a genuine preemption. `fresh:true` also drops its context.
   - `chain` runs a fixed sequence whose output feeds the next worker.
4. Prefer a thread worker when that teammate already owns relevant context.
   Prefer a preset for a bounded specialist job that should start cold.
5. When a human must choose, approve, or select several items, publish a frozen
   choice card. Do not ask them to type numbered replies.
6. Use `config_describe` to inspect effective settings and their source. Use
   `config_propose` for self/channel/preset/schedule changes; it posts a diff and
   waits for a human to Apply. Use cross-thread session controls only when the
   target is another thread in your channel.
7. If you create or edit a workspace file that the user should open, emit a
   `seam-attach` fence containing only its path. Do not merely mention the path.

## Tool routing by intent

Use this as a map, not as a substitute for each tool's live schema.

### Inspect and choose

- Team and context: `threads`, `peek`, `poll_inbox`. `threads` stamps each
  teammate's effective agent/model/effort identity; its name prefix also encodes
  agent, model, and role.
- Prior conversation in this channel: `search_messages` finds text and returns
  message-id anchors; `read_messages` loads the window around a hit. `peek` is
  the quick latest-N read and is the one read that reaches outside this channel.
- Current configuration, visible presets, and scheduled prompts:
  `config_describe`.
- Agent capacity before delegation: `agent_quota`.
- Model capability, price, context, and availability: `model_metadata_get`,
  `model_metadata_query`; Copilot cost-efficiency: `model_value_rankings`.
- A Seam-staged image when your model lacks native vision: `inspect_image`.

### Coordinate work

- Immediate task with automatic report-back: `handoff`.
- Thin immediate relay: `forward`.
- Non-interrupting note to a busy teammate: `send`.
- Mid-turn course correction: `steer`.
- Ordered multi-worker pipeline: `chain`.

### Manage thread sessions

- Change another thread's agent/model/effort/role: `configure_thread`. The
  response reports every effective field, explicitly marks no-ops, updates the
  target thread's name prefix to match its new identity, and posts a
  confirmation card there. Claude/meta effort reloads the runtime while
  preserving its ACP session and context.
- Clear another thread's context but keep its agent/model:
  `reset_thread_session`.
- Move this thread to a different agent/model and continue from an explicit
  handoff manifest: `migrate_self`. It stages until the current turn ends and
  always starts a fresh replacement session; at least the agent or model must
  actually change. Optional `rebuild: true` rebuilds from Discord first, then
  fires the manifest as the next live turn.
- Reclaim context while preserving the old session: `compact`.
- Rename this thread: `rename_thread`.

### Defer or automate work

- Re-enter this thread once at a future time or next process start:
  `schedule_wake`; revoke with `cancel_wake`. Use the Seam tool rather than an
  agent-native scheduler that may not emit after the current ACP turn ends.
- Wait for a file, HTTP, or command condition without spending repeated agent
  turns: `watch_create`; inspect/revoke with `watch_list` / `watch_cancel`.
- Create or edit a recurring schedule: `config_propose({ schedule: ... })`.
  Inspect IDs and full prompt text first with `config_describe`.

### Ask humans or accept external input

- In-thread decision: `create_choice`; revoke with `cancel_choice`.
- Reusable HTTP endpoint without a Discord card: `create_ingest`; revoke with
  `cancel_ingest`. Ingest-triggered agents return declared JSON with
  `submit_result`.

### Voice

- Gemini joins a voice channel for a parallel audio conversation:
  `create_live_help` / `cancel_live_help`.
- The admin-operated Shared Voice Console that routes speech among ACP threads
  is **Thread Voice**, controlled with `/seamadmin voice ...`; it is not Live Help.

## Task-specific guides

Load only what the task needs:

- A human choice, approval, multi-select, or cross-thread card →
  [Interactive prompts][interactive-prompts].
- A microsite or service submitting work over HTTP →
  [HTTP ingest][interactive-ingest].
- Model selection, another thread's runtime, or migrating your own thread →
  [Models and session control][model-intelligence].
- Gemini voice tutoring or conversational live audio → [Live Help][live-help].
- Admin operation of the multi-thread Shared Voice Console →
  [Thread Voice V2][thread-voice].
- "Is the provider down, or is it us?" when agent calls start failing →
  [Upstream service status][service-status].

The onboarding files are short transport prompts for persisting these links in
another repository; they are not competing specifications:

- [Interactive prompts onboarding][interactive-onboarding]
- [Live Help onboarding][live-help-onboarding]

## Keep context lean

- Do not load every guide pre-emptively. This primer plus the live tool schemas
  covers ordinary coordination.
- Do not copy full tool schemas into project instructions. Tool schemas change
  with the running host; persist the canonical primer link and only the local
  overlay that cannot be inferred (for example a course voice-channel ID).
- Do not teach implementation internals unless the task is to develop or debug
  Seam itself. Agents need observable behavior, scope, side effects, and the
  right tool—not storage tables, queue architecture, audio packet scheduling,
  or boot choreography.
- If a guide conflicts with the current repository instructions, harness, or
  live tool schema, follow the current source and flag the guide as stale.

[interactive-prompts]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts.md
[interactive-ingest]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-ingest.md
[model-intelligence]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/model-intelligence-and-thread-control.md
[live-help]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md
[thread-voice]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/thread-voice.md
[service-status]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/service-status.md
[interactive-onboarding]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/interactive-prompts-onboarding.md
[live-help-onboarding]: https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help-onboarding.md
