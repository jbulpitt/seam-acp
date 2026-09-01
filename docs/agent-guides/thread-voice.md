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
  Ending the console deletes its canonical VC-chat card after disconnecting.
  Starting a new console first removes terminal cards left in that voice
  channel by any earlier failed cleanup. Process restarts preserve active cards
  for normal boot recovery.

## Canonical card

The five-row card controls input selection, output selection, binding profile,
pagination/refresh, and console end. Only the owner/admin may mutate it; stale,
copied, or replaced controls are refused.

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

## Visible response speech

Every visible bound-thread turn can be spoken, including typed turns, Thread
Voice, wake/scheduled/watch turns, and handoff/report-back. Only visible prose
is spoken; status text, tool output, directives, harness text, fences, and quiet
dispatch are excluded.

All bindings share one fair speech queue while preserving each source's order.
Output-off cancels that binding's queued/current speech and applies until
re-enabled. Text delivery remains successful if speech synthesis fails. Native
voice-message TTS is suppressed while a binding belongs to an active console.

## Lease, recovery, and shutdown

Thread Voice and Live Help share one guild voice lease. A conflict should name
the active product/session; it is not an authorization or parent-approval
failure. Process recovery preserves active consoles and pending finalized text.
Missing VC-chat permission fails closed. Normal stop/shutdown disconnects and
releases the lease without deleting finalized transcripts by default.
