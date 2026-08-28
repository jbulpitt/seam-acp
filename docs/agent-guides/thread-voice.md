# Thread Voice v1

Thread Voice serializes one Discord member's speech into ordinary authenticated
turns in one Discord thread, then progressively speaks the agent's visible prose
back into the same voice channel. It is separate from Live Help: Thread Voice
uses the thread's configured ACP agent; Live Help is a parallel Gemini Live
conversation.

## Start, inspect, and stop

All v1 commands are admin-only and must be run inside the bound thread.

- Join a voice channel in the same guild and self-mute.
- Run `/seam voice start`. The interaction's Discord user ID is authoritative;
  display names never grant permission. The bot posts the capture/consent notice
  and one editable status panel.
- Unmute to speak. Only the owner is subscribed. Interim text is throttled in
  the panel; each finalized transcript is posted visibly before it enters the
  normal per-channel turn queue.
- Run `/seam voice status` for owner, voice channel, runtime, actual audio sent
  to Google, pending segments/characters, and the active dispatch ID.
- Run `/seam voice stop` to stop capture while preserving finalized pending text.
  Use `discard-pending:true` only when that text should be discarded. Text with
  an existing pending, running, or completed dispatch artifact is preserved.

The deployment must configure `SEAM_GEMINI_API_KEY`. Thread Voice reuses the
existing Gemini transcription, vocabulary, TTS model, voice, style, and pace
configuration helpers.

## Serialized behavior

- One Thread Voice binding exists per thread, and the owner has one active
  binding. V1 does not fan out to several threads or expose output toggles.
- Speech finalized while any channel turn is active accumulates durably. It does
  not abort, steer, interrupt, or bump the current turn's generation.
- Accumulated speech releases only after the channel turn and voice playback
  drain. `/seam queue` refuses while Thread Voice has buffered/batched text.
- Typed messages keep their existing interrupt behavior.
- Agent text remains normal Discord text. Only user-visible prose is segmented
  into sequential sentence/chunk Gemini TTS requests and 24 kHz mono playback.
  Code fences, tool output, and hidden protocol text are not spoken. A TTS
  failure is reported once in the thread and does not fail the text turn.
- While Thread Voice owns live playback, the completed-turn Discord voice-note
  attachment is suppressed to avoid duplicate speech.

## Voice lease and recovery

Thread Voice and Live Help acquire the same guild-scoped voice lease. A busy
error identifies the active product and durable session ID. Do not reinterpret
it as an authorization or parent-approval requirement; student Live Help
self-service is unchanged.

At boot, durable Live Help rows reconcile first, then Thread Voice sessions and
their dispatch artifacts reconcile before the dispatch watcher starts. On
shutdown the active call/playback is cleaned up and leases are released. An
owner disconnect uses the configured grace period before ending the binding.

## V1 boundary

V1 deliberately has no Shared Voice Console, multi-thread status card, fan-out,
per-thread output toggles, spoken routing, or multiple simultaneous bindings.
