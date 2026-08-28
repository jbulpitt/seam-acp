# Thread Voice — implementation specification

**Status:** V1 implemented and independently QA-verified on `main`; deployment pending  
**Owner:** Jesse  
**Scope:** advanced/admin user v1  
**Product relationship:** bidirectional voice interface to an existing ACP thread; distinct from Live Help

## 1. Decision summary

Thread Voice binds one Discord text thread (the **home thread**) to one Discord
voice channel for an explicit session owned by one admin user.

The owner uses Discord mute as push-to-talk:

1. The owner normally remains muted and listens.
2. Unmute starts one voice utterance.
3. Mute ends that utterance.
4. Seam streams only that unmuted audio to Gemini 3.5 Transcribe Live in Smart
   mode with the configured custom vocabulary.
5. A finalized transcript becomes a user-authored ACP prompt in the home
   thread.
6. The agent response continues to render as text in the home thread and is
   progressively spoken into the voice channel.
7. Speech received while an ACP turn or its speech playback is active never
   interrupts that turn. Final transcripts accumulate, in capture order, as
   one durable next-turn prompt.

Thread Voice is **not** Gemini Live Help. Live Help makes Gemini Live the coach.
Thread Voice keeps the existing thread's agent, model, tools, MCP servers,
permissions, repository, session history, and visible Discord transcript.

### Locked v1 product decisions

- Advanced/admin-only. This is not a family/student self-service surface in v1.
- One owner, one home thread, one Discord voice channel per session.
- The owner must already be in the target voice channel and self-muted before
  starting.
- Only the owner's audio is received or forwarded. Other VC participants are
  ignored.
- Discord self-mute is the authoritative turn boundary. No wake word.
- Muted time sends no PCM to Google and therefore adds no STT audio tokens.
- Speaking while a turn is busy queues the next prompt; it does not steer,
  abort, cancel, or barge in.
- A pending voice prompt releases only when both the ACP turn and its Thread
  Voice playback queue are finished.
- No raw audio is persisted. PCM/Opus buffers are memory-only. Finalized text
  is durable.
- Existing `/seam config tts` behavior remains unchanged outside Thread Voice.
  While Thread Voice is active, voice-channel playback replaces the post-turn
  voice-message attachment to avoid duplicate audio. The prior TTS setting
  resumes when Thread Voice stops.
- Thread Voice and Live Help cannot coexist in the same guild with the current
  single Discord bot connection.

## 2. Terminology

- **Home thread:** the Discord text thread whose persistent ACP session receives
  voice-authored prompts and displays agent output.
- **Thread Voice session:** the explicit binding among owner, home thread, and
  voice channel.
- **Owner:** the one authoritative Discord user id whose mute state and audio
  control the session.
- **Utterance:** audio between one owner mute-to-unmute edge and the following
  unmute-to-mute edge.
- **Transcript segment:** the finalized Smart transcript for one utterance.
- **Pending voice buffer:** ordered finalized transcript segments waiting to
  become the next ACP prompt.
- **Voice batch:** the atomic snapshot of pending segments assigned to one
  durable dispatch.
- **Voice lease:** the one-per-guild Discord voice connection reservation shared
  by Thread Voice and Live Help.

## 3. User experience

### 3.1 Slash surface

Add a new `/seam voice` group. The `/seam` tree remains under Discord's
top-level option limit.

- `/seam voice start`
  - Must run in a Discord thread.
  - Admin-only in v1.
  - The invoker must currently be in a visible, non-obfuscated voice channel in
    the same guild.
  - The invoker must be self-muted. Refuse with a precise instruction if not.
  - Uses the invoker's current VC; v1 has no arbitrary channel-id parameter.
  - Refuses if this thread, VC, or guild already holds an incompatible voice
    lease.
- `/seam voice stop discard-pending:false`
  - Owner or admin only.
  - Stops capture and playback, closes Google STT, leaves the VC, and ends the
    session.
  - Default preserves finalized pending text and lets it run normally.
  - `discard-pending:true` explicitly deletes finalized-but-undispatched
    segments.
- `/seam voice status`
  - Shows owner, home thread, VC, state, transmitted audio duration, current
    utterance state, pending segment count, pending character count, and active
    dispatch id if any.

Do not overload `/seam config tts state:on|off` with session lifecycle. A
persistent `live` config would autojoin unexpectedly after restart and is the
wrong privacy model. The explicit active Thread Voice session is the earlier
conceptual `live` mode.

### 3.2 Status panel

Post one editable panel in the home thread:

- Title: `🎧 Thread Voice`
- States: `Starting`, `Muted / ready`, `Capturing`, `Transcribing`, `Queued`,
  `Agent working`, `Speaking`, `Stopping`, `Ended`, `Failed`.
- Fields: owner, VC, transmitted audio duration, pending segments.
- Keep updates throttled. Do not create one Discord message per PCM or interim
  transcript event.
- Post the finalized transcript as a concise visible line when committed:
  `🎙️ Jesse: <Smart transcript>`.
- Interim text may edit one preview field while the owner is speaking; it must
  never dispatch and must disappear or be replaced by the finalized text.

### 3.3 Normal interaction

- Starting requires the owner to be muted, preventing capture immediately on
  join.
- On unmute, the panel changes to `Capturing` and Google receives
  `activityStart` followed by owner PCM.
- On mute, Google receives `activityEnd`; the finalized Smart transcript is
  committed when returned.
- Empty/noise-only utterances are ignored with no agent turn.
- A finalized transcript received while the home thread is idle dispatches at
  once.
- A finalized transcript received while busy appends to the next-turn buffer.
- The bot's voice output never changes the owner's pending-prompt semantics.
  If the owner speaks over it, that speech is captured for the next turn; v1
  does not stop or duck current playback.

## 4. State model

### 4.1 Session states

`starting -> ready -> stopping -> ended`

`ready` has observable substates derived from activity, not separately persisted:

- muted/ready
- capturing
- transcribing/finalizing
- queued
- agent working
- speaking

Any active state may transition to `failed` or `stopping`. Terminal rows remain
for audit.

### 4.2 Utterance states

`capturing -> finalizing -> pending -> batched -> dispatched`

Failure alternatives:

- `capture_dropped`: no usable speech or process loss before final text.
- `transcribe_failed`: Live finalization and unary fallback both failed.
- `discarded`: explicit stop/cancel policy removed finalized pending text.

Assign `sequence` at the unmute edge. Ordering is always `sequence`, never API
completion order.

### 4.3 Busy definition

For Thread Voice, the home thread is busy while any of these are true:

- a normal user turn occupies the orchestrator channel queue;
- a live dispatch occupies that queue;
- a Thread Voice agent turn is running;
- the Thread Voice speech queue still contains or is playing audio derived from
  that turn.

The next voice batch may be claimed only after all four are false.

## 5. Discord capture and mute gating

### 5.1 Source of truth

- Owner identity is the Discord snowflake captured from the authenticated slash
  interaction and voice state. Display name is presentation only.
- `voiceStateUpdate` self-mute edges define utterance start/end.
- Discord receiver `speaking` events and Opus packets provide audio only after an
  utterance has started.
- Ignore packets before the first unmute edge, after the mute edge, from the bot,
  or from any non-owner user.

### 5.2 Audio pipeline

- Subscribe to the owner with `EndBehaviorType.Manual`.
- Decode Discord Opus at 48 kHz; normalize to 16-bit PCM, 16 kHz, mono.
- Forward 20–100 ms PCM chunks to Transcribe Live as
  `audio/pcm;rate=16000`.
- Keep a bounded copy of the current utterance PCM in memory for unary fallback.
- Track forwarded bytes. At 16 kHz mono int16, transmitted audio duration is
  `bytes / 32,000` seconds.
- Never write PCM, WAV, OGG, or Opus capture data to disk.

### 5.3 Turn control sent to Google

Use Gemini 3.5 Transcribe Live manual VAD, matching the official push-to-talk
pattern:

- Disable automatic activity detection.
- Unmute: send `activityStart`.
- Stream owner PCM only while unmuted.
- Mute: send `activityEnd`.
- Consume interim hypotheses for the panel only.
- Commit only the finalized `inputTranscription` event.

If mute arrives but Google fails to finalize within a bounded timeout, close the
Live STT utterance and send the in-memory audio to existing unary
`gemini-3.5-transcribe` in Smart mode with the same custom vocabulary.

### 5.4 Limits

- Ignore captures shorter than 250 ms of voiced PCM.
- Limit one continuous unmute interval to 5 minutes. At the limit, finalize a
  continuation segment and continue capture under the same logical utterance
  until mute; concatenate its finalized parts in order.
- Rotate/reconnect the Google Live Transcribe session before its documented
  10-minute session limit. Reconnect is transparent and does not leave Discord.
- If the owner leaves the VC, end the session after a 30-second reconnect grace.

## 6. Gemini transcription configuration and cost

### 6.1 Live primary

- Model: `gemini-3.5-transcribe-live`
- Response modality: text
- Mode: `SMART`
- Language codes: empty for automatic detection
- Custom vocabulary: reuse `SEAM_GEMINI_STT_CUSTOM_VOCABULARY`; normalize and
  deduplicate exactly as voice-note STT does. Keep the practical cap at 100
  terms even though the API permits 1,000 because Google recommends roughly 100
  for best results.
- Manual VAD: Discord mute edges send activity start/end.

### 6.2 Unary fallback

- Model: configured `SEAM_GEMINI_STT_MODEL`, currently
  `gemini-3.5-transcribe`.
- Mode: Smart.
- Custom vocabulary: same resolved list.
- Input: in-memory audio only.

### 6.3 Billing behavior

Google's paid-tier estimate as of 2026-08-27:

- Transcribe Live: approximately `$0.009` per transmitted audio minute blended
  across audio input and transcript text output.
- Unary Transcribe: approximately `$0.005` per submitted audio minute blended.
- Free-tier pricing is currently listed as free of charge.

The implementation must bill-gate by bytes sent, not by voice-channel or socket
wall time:

- Muted owner: send no PCM; zero new STT audio tokens.
- Connected Google WebSocket with no PCM: no audio duration is submitted.
- Unmuted silence/noise that is actually forwarded is billable audio duration.
- Local packet/energy gating should omit Discord silence/comfort-noise frames,
  but mute remains the reliable cost control.

Examples at paid-tier estimates:

- Connected for 60 minutes, speaking for 10 transmitted minutes: roughly
  `$0.09` Live STT.
- Naively forwarding all 60 minutes, including silence: roughly `$0.54`.
- Sending the same 10 minutes through unary fallback: roughly `$0.05`.

These estimates exclude TTS and the ACP agent/model. Do not hardcode dollar
pricing into runtime logic; expose transmitted audio duration so current rates
can be applied externally.

Official references:

- https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe

## 7. Durable pending-prompt semantics

### 7.1 Append behavior

Each finalized transcript becomes one durable segment immediately. If a turn is
busy, append it; never replace prior segments.

When the thread becomes fully idle:

1. In one SQLite transaction, select every `pending` segment for the active
   session/home thread ordered by sequence.
2. Create a stable voice batch/dispatch id.
3. Mark those rows `batched` with that dispatch id.
4. Compose one prompt preserving segment boundaries.
5. Enqueue one durable live dispatch using the stable id.

Example composed prompt:

```text
<thread-voice-input owner-id="1487094572696867019">
Voice segment 1:
Also compare this with the previous approach.

Voice segment 2:
Check whether it affects the mobile client.

Voice segment 3:
Do not deploy anything yet.
</thread-voice-input>
```

The harness-stamped speaker id remains the authority. The XML-like wrapper is
content/provenance, not an authorization source.

### 7.2 Atomic snapshot rule

- Segments committed before the batch transaction belong to that batch.
- Speech finalized after the transaction belongs to the following batch.
- Only one pending/running Thread Voice dispatch may exist per home thread.
- The dispatch does not bump channel generation and never calls `abortTurn`.
- Normal human text retains current priority/interrupt behavior. It does not
  erase finalized Thread Voice segments.

### 7.3 Dispatch integration

Add `thread_voice` as a durable dispatch/ledger kind. Add trusted speaker
metadata to the dispatch spec:

- `authorId`
- `authorName` (presentation only)
- `threadVoiceSessionId`

Schema validation must allow those fields only for `kind: "thread_voice"`.
The producer is server-side Discord voice capture; arbitrary MCP callers do not
mint this kind.

Thread Voice dispatch must:

- reuse the home thread's live ACP session;
- serialize through the existing per-channel queue;
- build the same channel/thread riders and speaker-identity harness as an
  ordinary user-authored turn;
- set `currentSpeakerIds` and `currentAuthorIds` only for the duration of the
  verified voice-authored turn;
- preserve the user's normal tool/MCP/config permissions;
- stream normal text output into the home thread;
- feed agent prose into the Thread Voice speech pipeline;
- write normal live-turn and delegation markers so restart/resume semantics are
  unchanged.

Extract a shared user-prompt builder rather than copying the ordinary message
path. Other dispatch kinds must continue to carry no human speaker.

### 7.4 Crash recovery

- Finalized transcript rows are durable; audio and interim text are not.
- A crash before final transcript may lose only the active in-memory utterance.
  On restart, post a visible notice that the in-progress capture was lost.
- A batch with a stable dispatch id is re-enqueued only when no matching
  pending/running/done dispatch artifact exists.
- A running Thread Voice dispatch follows existing live-turn resume behavior.
  Never create a second batch for rows already tied to that dispatch id.
- On boot, if the owner is still present and muted in the VC, reconnect the
  Discord voice transport and mark the session ready. Otherwise end the session.
- Pending finalized segments survive session end and still run unless explicitly
  discarded.

## 8. Agent output and progressive TTS

### 8.1 Output routing

While a Thread Voice session is active for the home thread:

- Text output renders exactly as it does today.
- Do not call the completed-turn voice-message attachment path.
- Feed user-visible agent prose into a sentence/chunk segmenter.
- Synthesize chunks sequentially with existing
  `gemini-3.1-flash-tts-preview`, current thread voice, pace, and style.
- Convert 24 kHz mono PCM to Discord 48 kHz stereo Opus and enqueue 20 ms
  packets on the session's persistent audio player.

The current TTS Interactions helper returns one complete PCM result per request.
V1 is therefore **progressive by sentence/chunk**, not byte-streaming inside one
TTS request. Playback begins after the first chunk synthesizes, before the ACP
turn finishes.

### 8.2 Speech segmentation

Create a pure, unit-tested `StreamingSpeechSegmenter`:

- Consume agent-text chunks in arrival order.
- Exclude code fences, seam directives, raw tool output, and markdown-only
  syntax.
- Prefer sentence-ending punctuation followed by whitespace.
- Flush on paragraph boundary.
- Target 80–320 characters per chunk.
- Force-flush around 400 characters at the safest available boundary.
- Flush the final speakable tail at turn end.
- Reuse current URL/technical-content paraphrasing instructions in
  `buildTtsInput`.

### 8.3 Queue and completion

- One synthesis queue and one playback queue per Thread Voice session.
- Preserve chunk order even if requests are implemented concurrently later.
- V1 may synthesize only one chunk at a time to simplify ordering and quotas.
- ACP turn completion does not release the next voice prompt until synthesis
  and playback both drain.
- Owner speech during playback is captured for the next prompt and does not
  interrupt the player.

### 8.4 Failure behavior

- One chunk TTS failure posts/logs one concise warning and continues with later
  chunks.
- If the entire live speech path fails, text remains successful.
- At turn end, optionally fall back to the current completed Discord voice
  message only if no live chunk was played. Never produce both full live speech
  and a duplicate full attachment.
- Voice connection loss stops playback, preserves text, and leaves pending input
  transcripts durable.

## 9. Shared voice lease and Live Help conflict

Introduce a guild-scoped `VoiceLeaseManager` used by both Live Help and Thread
Voice.

Lease fields:

- kind: `live_help | thread_voice`
- owner/session id
- guild id
- voice channel id
- acquired UTC

Rules:

- Exactly one lease per guild for this Discord bot.
- Start/mint must acquire before `joinVoiceChannel`.
- Release in every success, cancellation, error, and shutdown path.
- A refusal names the active kind and session id. Never translate a technical
  busy-guild conflict into an authorization/parent-approval message.
- Process boot starts with no in-memory lease; reconciliation inspects durable
  rows before reconnecting either product.

The v1 lease owner is one Thread Voice session with one home-thread binding.
Keep the lease interface capable of belonging to a future guild-level Voice
Console that owns several thread bindings over the same Discord connection;
do not encode the home-thread id into the generic lease key.

## 10. Persistence

Add these SQLite concepts through `SessionStore` migrations.

### 10.1 `thread_voice_sessions`

- id, primary key
- platform
- channel_ref (home thread)
- parent_ref
- guild_id
- voice_channel_id
- owner_user_id
- owner_name (presentation snapshot only)
- status
- notice_message_id
- transmitted_audio_ms
- created_utc, updated_utc, ended_utc
- end_reason

Indexes/constraints:

- one active session per home thread;
- one active session per guild;
- active lookup by VC and owner.

### 10.2 `thread_voice_segments`

- id, primary key
- session_id
- sequence
- author_id
- transcript
- state
- audio_ms
- dispatch_id, nullable
- captured_started_utc, captured_ended_utc
- created_utc, updated_utc
- error, nullable

Constraints/indexes:

- unique `(session_id, sequence)`;
- pending lookup by home thread/session and sequence;
- dispatch-id lookup for recovery.

Store finalized transcript text only. Do not add an audio blob/path column.

## 11. Manager and platform interfaces

Add platform-neutral core types under `core/thread-voice/` and keep Discord
media mechanics under `platforms/discord/`.

Suggested manager host interface:

```ts
interface ThreadVoiceHost {
  inspectOwnerVoiceState(userId: string, guildId: string): Promise<OwnerVoiceState>;
  runSession(opts: {
    row: ThreadVoiceSession;
    signal: AbortSignal;
    onState: (state: ThreadVoiceRuntimeState) => void;
    onInterim: (sequence: number, text: string) => void;
    onFinal: (segment: FinalVoiceSegment) => void;
    onAudioSent: (durationMs: number) => void;
  }): Promise<{ reason: string }>;
  speak(sessionId: string, pcm: TtsPcm): Promise<void>;
  waitForPlaybackIdle(sessionId: string): Promise<void>;
  notify(threadId: string, panelOrText: unknown): Promise<void>;
}
```

The manager owns lifecycle, durable segments, batching, and release decisions.
The Discord host owns voice state, receiver subscriptions, Opus/PCM conversion,
player, and connection teardown.

## 12. Cancellation and coexistence

- `/seam voice stop` ends capture/playback but defaults to preserving committed
  pending transcripts.
- `/seam voice stop discard-pending:true` explicitly discards pending rows.
- Plain `/seam cancel` cancels the active ACP turn; pending voice text remains
  and releases afterward.
- `/seam cancel force:true` also stops current Thread Voice playback. Pending
  finalized text remains unless the user explicitly chose discard.
- `/seam cancel scope:all` stops all active Thread Voice sessions as part of the
  privileged global shutdown, but does not silently delete durable transcripts.
- `/seam queue` is rejected while Thread Voice has pending/batched text in that
  home thread. This avoids two independent “next prompt” products racing. Once
  the voice buffer is empty, `/seam queue` works normally.
- Normal typed messages keep existing interrupt behavior and do not clear the
  pending voice buffer.

## 13. Security, privacy, and authorization

- Admin-only v1 using authoritative Discord user ids.
- Starting the session is explicit consent to capture the owner's unmuted audio.
- Require start while self-muted.
- Ignore all non-owner audio even when others are in the VC.
- Do not expose `DISCORD_BOT_TOKEN` or Gemini keys to the client or thread.
- No raw audio persistence or recording/download feature.
- Final transcript is visible in the home thread and stored as prompt history;
  state this in the start confirmation.
- Respect Discord channel visibility/obfuscation checks already used by Live
  Help.
- Speaker name is never used for authorization or scope.
- Trusted dispatch speaker metadata is accepted only from the internal Thread
  Voice producer and only when it matches the durable session owner.

## 14. Observability

Structured logs should include:

- threadVoiceId, home thread, guild, VC, owner id
- state transitions and end reason
- utterance sequence
- captured/forwarded audio duration and bytes
- interim/final transcript character counts (not full text in logs)
- Live STT fallback events
- pending segment count and batch/dispatch id
- TTS chunk count, synthesis latency, playback duration, failures
- lease acquisition/refusal/release

`/seam voice status` reports transmitted audio duration, not a hardcoded dollar
estimate.

## 15. Acceptance criteria

### 15.1 Start/stop and authorization

- Admin in a thread, already muted in a same-guild VC, can start.
- Start is refused when unmuted, outside a VC, non-admin, obfuscated, or guild
  voice lease is busy.
- Stop always destroys Discord/Google resources and releases the lease.
- Only the owner is captured.

### 15.2 Cost gating

- Sixty seconds muted produces zero calls that send PCM and increments
  transmitted audio duration by zero.
- Unmute sends activity start and PCM; mute sends activity end and stops PCM.
- Silence/comfort frames are not counted unless actually forwarded.

### 15.3 Transcription

- Live setup uses `gemini-3.5-transcribe-live`, text response modality, Smart
  mode, manual activity detection, and configured vocabulary.
- Interim text never dispatches.
- Final text dispatches/queues once.
- Live failure uses buffered unary Smart fallback once without duplicating a
  successful final.

### 15.4 Turn accumulation

- Voice during an active turn never calls abort and never bumps channel
  generation.
- Three utterances finalized while busy become one next prompt with three
  ordered segments.
- Out-of-order API completions still produce capture order.
- Speech finalized after batch claim belongs to the following turn.
- The next batch waits for ACP completion and TTS playback drain.

### 15.5 Durability

- Restart with pending finalized segments preserves them.
- Recovery does not enqueue a second dispatch for an existing stable dispatch
  id.
- In-progress raw capture is not written to disk.
- Running turns retain existing turn-resume behavior.

### 15.6 Progressive speech

- For a multi-sentence agent response, first voice playback starts before the
  ACP turn completes.
- Sentence order is preserved.
- Code fences and seam directives are not spoken.
- Active Thread Voice suppresses duplicate completed-turn TTS attachment.
- Text output succeeds even when TTS fails.

### 15.7 Regression

- Existing voice-note STT remains Smart + custom vocabulary.
- Existing `/seam config tts` voice-message behavior is unchanged without an
  active Thread Voice session.
- Live Help still works and now shares the explicit guild lease.
- School/student Live Help self-service authorization is unchanged.
- Existing `/seam queue`, dispatch serialization, restart drain, and cancel
  tests remain green.

## 16. Implementation packages for delegation

Do not have multiple workers edit `orchestrator.ts`, `index.ts`, `commands.ts`,
or `session-store.ts` concurrently. Foundation packages can run in parallel;
integration is deliberately serialized.

### Package A — core state, persistence, and voice lease

Ownership:

- `packages/core/src/core/thread-voice/types.ts` (new)
- `packages/core/src/core/thread-voice/manager.ts` (new)
- `packages/core/src/core/voice-lease.ts` (new)
- `packages/core/src/core/session-store.ts`
- focused store/manager/lease tests

Deliverables:

- schemas/types and ids;
- SQLite migrations and store methods;
- append/order/batch/recovery rules;
- lifecycle manager with injected host/dispatch callbacks;
- shared guild lease abstraction;
- no Discord imports.

Package A may run in parallel with B and C, but owns `session-store.ts` alone.

### Package B — Gemini Live Transcribe client

Ownership:

- `packages/core/src/core/audio/gemini-live-transcribe.ts` (new)
- small reusable custom-vocabulary helpers if needed
- focused mocked-WebSocket tests

Deliverables:

- documented Live setup: Text, Smart, manual VAD, custom vocabulary;
- activity start/end, PCM send, interim/final callbacks;
- session rotation/GoAway/close behavior;
- forwarded-byte telemetry;
- exactly-once unary fallback contract using buffered PCM;
- no Discord imports and no orchestrator changes.

### Package C — speech segmentation and Discord voice transport

Ownership:

- `packages/core/src/core/audio/streaming-speech-segmenter.ts` (new)
- `packages/core/src/platforms/discord/thread-voice-call.ts` (new)
- media-focused tests

Deliverables:

- pure streaming prose segmenter;
- owner-only mute/speaking capture;
- Opus 48 kHz to PCM 16 kHz mono input conversion;
- persistent Discord audio player and PCM-to-Opus output queue;
- playback-idle promise;
- memory-only capture and cleanup;
- reuse/extract Live Help codec helpers only when it reduces duplication without
  destabilizing Live Help.

Package C may use temporary interfaces matching this spec until Package A lands.
It must not edit Live Help orchestration or global wiring.

### Package D — serialized integration

Start only after A, B, and C are reviewed.

Ownership:

- `packages/core/src/platforms/discord/orchestrator.ts`
- `packages/core/src/platforms/discord/commands.ts`
- `packages/core/src/platforms/discord/adapter.ts`
- `packages/core/src/index.ts`
- dispatch kinds/schema/prompt-builder extraction
- Live Help lease wiring
- command/integration tests and documentation

Deliverables:

- `/seam voice start|stop|status`;
- status panel and finalized transcript echo;
- thread-idle hook and stable durable dispatch creation;
- trusted speaker identity on Thread Voice dispatch only;
- agent event -> sentence TTS -> Discord playback;
- playback-drain gating;
- duplicate TTS suppression;
- shared voice lease wired into Live Help;
- boot reconciliation and shutdown.

### Package E — adversarial QA and hardening

Run after integration in a clean worktree.

Focus:

- mute edge races;
- owner disconnect/reconnect;
- restart between segment batch and dispatch file creation;
- Live STT final plus fallback race;
- turn completion versus final TTS packet race;
- normal typed interrupt while voice text is pending;
- cancel/stop/discard semantics;
- Live Help/Thread Voice lease conflict;
- resource leak checks;
- full test suite and one controlled live Discord probe.

QA does not redesign behavior. Any spec ambiguity blocks integration and is
reported to the lead.

## 17. Delegation and merge order

When Jesse approves implementation:

1. Load the `wt` helper instructions and create isolated `wt` worktrees.
2. Delegate A, B, and C in parallel with this spec as the sole behavioral
   authority.
3. Require each worker to commit focused changes and report commit hash, tests,
   and deviations.
4. Review A/B/C before integration; resolve interface differences centrally.
5. Delegate or perform Package D on a fresh integration branch. No cherry-pick
   should overwrite unrelated user work.
6. Run Package E against the integrated branch.
7. Merge, run the full suite, commit/push only requested files, then deploy with
   `npm run redeploy` and a restart-triggered seam-MCP wake.
8. Live probe requires Jesse already in the chosen VC and muted. Do not autojoin
   or capture without that fresh explicit start.

## 18. Explicit non-goals for v1

- Family/student self-service Thread Voice
- Multiple owners or speaker diarization
- Wake words or always-listening room transcription
- Barge-in, playback ducking, or agent steering from speech
- Multiple home-thread bindings sharing one guild voice channel
- Spoken thread routing or focus commands
- Audio recording or download/archive
- Screen share, webcam, Discord Go Live, or image frames
- Replacing Gemini Live Help
- Byte-streaming one TTS request; v1 streams by synthesized sentence/chunk
- Automatic persistent VC join merely because a config flag is set

## 19. Follow-ons after v1

- **Shared Voice Console / multi-thread mode.** One guild-level console owns the
  Discord connection, owner capture, one Gemini transcription stream, and one
  global playback scheduler. Several independent `ThreadVoiceBinding` records
  attach home threads to that console. This is multiplexing over one VC, not
  several Discord voice connections.
- Each binding has an immutable thread id, a short unique spoken alias, and a
  persistent Gemini TTS voice. Existing Gemini synthesis already accepts the
  voice per request, so responses from different threads can use distinct
  voices without changing their text-thread TTS configuration.
- The Voice Console has one canonical persistent status card as its control
  plane. It lists every bound thread with alias, assigned voice, agent state,
  pending-input count, and playback state. Component custom ids carry immutable
  binding ids; thread titles and aliases are presentation only.
- The card owns an explicit set of **selected input targets**:
  - zero selected means `Input off`; do not forward PCM to Gemini or create a
    transcript while no destination can receive it;
  - one selected is the normal focused-thread mode;
  - several selected is an intentional fan-out mode in which the same finalized
    utterance becomes authenticated input to every selected thread.
- Single-target mode is the default: claiming another thread replaces the
  current selection. Multi-target mode must be deliberately enabled and remain
  conspicuously visible on the card. Provide an explicit `Input off` control as
  well as treating an empty selection as off. This is input gating, not Discord
  self-mute and not output/playback mute.
- Snapshot the selected binding ids at the owner's unmute edge. Changes from one
  non-empty target set to another during an utterance apply to the next
  utterance, preventing half an utterance from being routed under different
  policies. `Input off`, including deselecting the last target, is the safety
  exception: immediately stop forwarding PCM, send activity end, and discard
  the unfinished capture. Revalidate permissions and active bindings before
  committing each target.
- A fan-out capture has one capture id and one transcript, then creates one
  durable segment per selected binding linked by a `fanoutGroupId`. Each target
  proceeds independently through its own busy queue. Agent and TTS costs may
  therefore multiply even though transcription occurs only once.
- Each binding also has an independent persistent **VC output enabled** toggle
  on the same card. This controls only whether that thread is spoken into the
  shared voice channel; it never pauses/cancels the agent, hides Discord text,
  changes input targeting, or modifies the thread's normal TTS configuration.
  A thread may receive spoken input while its VC output is disabled.
- Disabling a binding's output takes effect promptly: cancel that source's
  currently playing chunk, invalidate its queued/synthesizing chunks, and let
  the global scheduler continue with another enabled source. Already submitted
  TTS requests may still incur cost, but do not start new synthesis for disabled
  bindings.
- Output disabled is **drop, not pause**. Do not accumulate an audio backlog.
  Re-enabling applies to future complete speech chunks only; it must not read all
  responses produced while disabled. If re-enabled during a streaming agent
  turn, resume at the next clean sentence/chunk boundary.
- Show input selection and output state as separate indicators/actions for each
  binding. Also provide an `Output all off/on` convenience control. Global
  output-off leaves capture and selected input targets unchanged. Persist these
  output preferences across card recovery and process restart.
- For a small binding set the card may expose direct claim buttons. Because
  Discord limits component rows and menus, larger sets use a paginated select
  menu. Input and output selectors must remain visually distinct. The card must
  edit in place and recover its selected/off state after restart without
  generating a stream of status messages.
- Do **not** normally speak `Kanoa thread says` before each response. The voice
  itself identifies the source. Show the alias-to-voice map in the console's
  Discord status panel and provide voice previews when configuring bindings.
- The scheduler serializes all output; Discord never receives overlapping bot
  audio. It may rotate among ready threads at sentence/chunk boundaries for
  fairness, preserving order within each thread. A voice switch is sufficient
  attribution; spoken labels remain an optional accessibility/debug fallback.
- Capture is still transcribed once. A deterministic router accepts an exact
  binding alias (`Kanoa: ...`) or a focus command (`Switch to Kanoa`), then sends
  the finalized transcript to that binding's ordinary durable pending buffer.
  An unprefixed utterance goes to the card's snapshotted selected target set.
  Spoken routing commands mutate or override that same visible control-plane
  state rather than maintaining a second invisible routing state.
- Outside deliberately enabled card fan-out, route one utterance to exactly one
  binding. Unknown, duplicate, or ambiguous aliases dispatch nowhere and
  require an explicit Discord choice. Do not let an LLM silently infer an
  executable destination. Compound instructions that contain different content
  for several threads can be added later only with structured parsing and
  visible confirmation; card fan-out always sends the same transcript to every
  selected binding.
- Multi-thread mode does not multiply STT usage because the owner's audio is
  transcribed once and routed locally. It can multiply ACP-agent and TTS usage
  when several bound threads produce responses.
- Preserve the v1 persistence boundary so this can be added without migrating
  transcript history: evolve the one-to-one session/home-thread relationship
  into `VoiceConsoleSession -> ThreadVoiceBinding[]`, while each binding keeps
  its own segment, batch, dispatch, and playback-source identity.
- Multi-owner sessions with explicit allowlist and per-speaker attribution
- Barge-in mode that cancels playback without steering the current ACP turn
- Optional interim caption panel in a separate notify thread
- Multiple Discord bot identities for concurrent guild voice leases
- A shared extracted Discord voice codec/transport library for Live Help and
  Thread Voice
- Live TTS endpoint adoption if Google exposes a stable byte-streaming API that
  materially improves first-audio latency over sentence pipelining
