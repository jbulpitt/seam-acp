# Thread Voice V2 — Shared Voice Console

Thread Voice connects one Discord voice channel to as many as ten ACP thread
bindings. Authorized speakers route each mute-to-unmute utterance to the selected
binding (or an explicitly armed fan-out set), and the visible agent prose from
every active binding shares one fair VC speech scheduler. Live Help remains a
separate Gemini Live product and keeps its student self-service behavior.

## Start and bind threads

All `/seam voice` commands and card controls are owner/admin control surfaces.
Speaker authorization is separate: audio is accepted only for current members
of `DISCORD_ALLOWED_USER_IDS`.

- Join a visible voice channel in the same guild and self-mute.
- Run `/seam voice start alias:…` inside the first ACP thread. Seam verifies
  `ViewChannel`, `Connect`, `SendMessages`, `EmbedLinks`, and
  `ReadMessageHistory`, then posts the canonical card in the voice channel's
  built-in chat before it creates durable state, acquires the lease, or joins.
- Run `/seam voice add alias:… claim:true` in another thread to add a binding.
  `claim` defaults true. Aliases are console-local, inert presentation labels.
- Run `/seam voice remove discard-pending:false` in a bound thread to remove
  that binding. Finalized text is preserved unless explicitly discarded and no
  dispatch artifact owns it.
- Run `/seam voice configure alias:… voice:… pace:… style:…` for the current
  binding. Voice autocomplete uses the existing Gemini TTS catalog.
- Run `/seam voice console repost:true` only to replace a missing canonical
  card in the same VC chat. There is no thread or text-channel fallback.
- Run `/seam voice status` for paginated capture, speaker, binding, ACP,
  scheduler, lease, STT, and card diagnostics.
- Run `/seam voice stop discard-pending:false` to stop the whole console.

## Canonical card

The five-row card controls input selection, output selection, binding profile,
pagination/refresh, and console end. Custom IDs contain immutable console and
binding IDs plus the durable revision. Only the owner/admin may mutate it;
copied, stale, replaced-message, wrong-channel, and duplicate interactions are
refused or replayed idempotently.

Input off aborts active speaker captures and allocates no new sequences. More
than one selected input requires the explicit fan-out arm. Output off cancels
that binding's queued/current speech and advances its durable generation;
re-enable applies only to future visible text.

## Capture and dispatch

- Each authorized Discord user has one speaker lane even across device/session
  changes. Unauthorized audio is never subscribed, decoded, or sent to STT.
- Mute arms readiness; unmute begins capture. Authorization is checked again at
  finalization. The target set and per-binding sequences are frozen at the
  utterance edge, so mid-utterance card edits affect only the next utterance.
- Final transcripts are echoed visibly with the actual speaker identity, then
  released independently through each binding's ordinary per-channel queue.
- Busy bindings accumulate without aborting, steering, or generation bumps.
  Release waits for the channel turn and that binding's accepted VC speech to
  drain. `/seam queue` refuses while finalized/batched voice text exists.
- Trusted `thread_voice` dispatch metadata is verified against the durable
  console, binding, batch, and actual speaker. External dispatch producers
  cannot mint those fields.

## Visible response speech

Every visible bound-thread agent turn uses one shared speech hook, including
typed turns, Thread Voice, wake/scheduled/watch turns, handoff/report-back, and
generic visible dispatch. Only visible prose is spoken; status text, headers,
tools, directives, harness text, and fences are excluded. Quiet/non-streamed
dispatch speaks nothing, and terminal aggregates are never spoken twice.

The global scheduler makes sequential Gemini TTS sentence/chunk requests,
shares one 24 kHz mono player, preserves source-local order, and rotates fairly
between ready sources. Text remains successful if TTS fails. Native completed-
turn voice-message TTS is suppressed for every active binding, including while
that binding's VC output is off.

## Lease, recovery, and shutdown

Thread Voice and Live Help share one guild voice lease. A conflict names the
active product and durable session; it is not an authorization or parent-
approval failure.

Boot order is store migration, Live Help lease reconciliation, Voice Console
manager/runtime construction, V1 upgrade, console/card/artifact recovery, then
dispatch watcher start. A V1 session becomes a one-binding console while its
binding ID, pending text, and profile are preserved. Missing VC-chat permission
fails closed. Shutdown drains/removes capture, scheduler/player, the single
Discord connection, and the lease without deleting transcripts.
