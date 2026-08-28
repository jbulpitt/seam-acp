# Thread Voice V2 — Shared Voice Console specification

**Status:** Product decisions locked; ready for implementation planning

**Owner:** Jesse

**Date:** 2026-08-28

**Depends on:** shipped Thread Voice V1 and its independently verified durability, STT, dispatch, and TTS contracts

**Scope:** advanced/admin-operated Shared Voice Console; card-based routing only

## 1. Decision summary

Thread Voice V2 replaces the one-thread/one-call V1 runtime with one
guild-scoped **Shared Voice Console**. The console owns the guild's single
Discord voice connection, one owner capture path, one Gemini Live Transcribe
client, one canonical Discord control card, and one global speech scheduler.

Up to ten independent **thread bindings** attach existing ACP threads to that
console. Each binding keeps its own durable input segments, ACP queue, agent
turns, TTS identity, output preference, and cancellation boundary.

The card is the only routing control plane:

- zero selected input bindings means `Input off`;
- one selected binding is the normal focused mode;
- several selected bindings are explicit fan-out mode;
- each binding independently enables or disables voice-channel output;
- the console can disable or enable all output without changing input targets.

There is no spoken routing in V2. Transcripts are never parsed for thread
aliases, focus commands, or compound destinations. If the owner says “tell the
Kanoa thread…”, those words are ordinary prompt content delivered to the
binding(s) selected on the card.

The V1 safety and durability rules remain:

- one authenticated admin owner;
- self-mute edges define utterance boundaries;
- merely unmuting does not interrupt playback and does not dispatch anything;
- only actual owner PCM inside an armed utterance reaches STT;
- speech received while a target is busy becomes that target's durable next
  prompt and never steers or aborts the current turn;
- text output remains authoritative when speech fails;
- no raw audio is persisted;
- Live Help and Thread Voice remain mutually exclusive through one guild voice
  lease.

## 2. Goals

V2 must:

1. Let one owner bind several Discord ACP threads to one voice channel.
2. Let the owner choose input destinations explicitly from one persistent card.
3. Support deliberate same-transcript fan-out without multiplying STT work.
4. Let each binding's voice output be muted or restored independently.
5. Use distinguishable, persistent TTS profiles instead of spoken thread labels.
6. Serialize all bot audio while preventing one noisy binding from monopolizing
   playback.
7. Preserve independent ACP, pending-input, failure, and cancellation behavior
   for every binding.
8. Recover the console, card state, bindings, and durable text safely after a
   process restart.
9. Upgrade an active V1 session into a one-binding console during deployment.
10. Keep all card actions authenticated, versioned, durable, and visible.

## 3. Explicit non-goals

V2 does not include:

- spoken aliases, “switch to” commands, or LLM destination inference;
- compound spoken commands for different threads;
- multi-owner capture, speaker diarization, or participant input;
- family/student self-service authorization;
- barge-in, playback ducking, or speech-based ACP steering;
- overlapping bot audio or multiple Discord voice connections in one guild;
- persistent raw audio, recording, archives, or downloads;
- screen share, webcam, Discord Go Live, or image frames;
- replacing Gemini Live Help;
- byte-streaming a single Gemini TTS request;
- automatic VC joining from a passive config flag;
- changing a thread's ordinary `/seam config tts` settings;
- more than ten bindings or more than five simultaneous fan-out targets;
- native completed-turn voice-message attachments while the thread is bound;
- a public/student control card.

## 4. Terminology

- **Voice Console:** the guild-level active product session that owns Discord
  voice, STT, capture routing, the control card, and global speech scheduling.
- **Control thread:** the Discord thread containing the canonical console card.
- **Binding:** one immutable association between a console and an ACP home
  thread. A thread has at most one active binding in its guild.
- **Binding alias:** a short unique presentation label shown on the console.
  It is never parsed from speech and never used as an authority key.
- **Input target set:** the durable set of binding ids eligible to receive the
  next owner utterance.
- **Input off:** an empty input target set. Audio is not forwarded to Google.
- **Fan-out armed:** the explicit mode allowing two through five input targets.
- **Capture snapshot:** the immutable binding-id and per-binding sequence set
  captured at a valid owner unmute edge.
- **Fan-out group:** one STT transcript committed as separate durable segments
  to several snapshotted bindings.
- **VC output enabled:** a binding preference allowing future agent prose to be
  synthesized and played in the shared voice channel.
- **Speech source:** one binding/ACP-turn pair contributing ordered chunks to
  the global scheduler.
- **Console revision:** a monotonically increasing value used to reject stale
  card interactions.

Thread titles, display names, aliases, menu labels, and TTS voice names are
presentation. Console ids, binding ids, Discord user ids, channel ids, and
revisions are authority.

## 5. Locked product behavior

### 5.1 Ownership and authorization

- V2 remains admin-only through `SEAM_CONFIG_ADMIN_USER_IDS`.
- The authenticated Discord interaction user id becomes the immutable console
  owner id.
- Only the console owner or another configured admin may operate the slash
  commands or card. A participant clicking a copied/stale component is refused.
- Capture accepts only the owner id. All other Discord speakers are ignored.
- Every binding must be an existing ACP thread in the same guild and accessible
  to the bot.
- One console may have at most ten active bindings.
- One guild may have at most one active Voice Console or Live Help session.

### 5.2 Mute and speech safety

- The owner must be in the target VC and self-muted when creating the console.
- A self-mute-to-unmute edge only arms one utterance. It does not by itself send
  audio, interrupt playback, or create an input segment.
- Discord `speaking`/Opus packets supply audio only after that valid edge.
- Very short/noise-only captures remain dropped under the V1 threshold.
- Muting ends the utterance and asks STT to finalize.
- Owner speech during agent work or playback queues input for selected bindings;
  it does not stop current work or audio.
- If input targets are enabled while the owner is already unmuted, capture stays
  disabled until a fresh mute followed by unmute. The card must say
  `Mute, then unmute to speak`.
- Reconnect while unmuted has the same fresh-mute requirement.

### 5.3 Card-only routing

- The card's durable input target set is the sole routing source.
- The console does not inspect transcript wording to choose a target.
- Aliases are display labels only.
- No hidden in-memory focus may diverge from the card.
- An unprefixed, prefixed, imperative, or ambiguous utterance is treated
  identically: it goes to the snapshotted target set.
- Destination changes are visible card interactions and durable before they
  can affect a later capture.

### 5.4 Input modes

- `Input off`: zero targets; owner PCM is dropped locally and STT receives no
  audio.
- Focused: exactly one target; the normal mode.
- Fan-out: two through five targets while fan-out is explicitly armed.
- The first binding created with a console is selected automatically.
- `/seam voice add` claims the added binding by default:
  - fan-out off: it replaces the previous selected binding;
  - fan-out armed: it joins the target set if the five-target cap allows it.
- The add command exposes `claim:false` for adding without changing targets.
- Any visible agent prose produced in an active bound thread is eligible for VC
  speech when that binding's output is enabled, whether the turn began from
  voice input, a typed message, a wake, or another trusted dispatch. Hidden or
  silent turns remain silent.

### 5.5 Capture snapshot and mid-utterance changes

At a valid unmute edge:

1. Read the console and selected bindings in one transaction.
2. Refuse capture if the target set is empty.
3. Revalidate that each binding is active, owned by this console, and points to
   a valid thread.
4. Allocate one ordered sequence for every selected binding.
5. Persist or retain a memory-only capture record containing one capture id,
   the console revision, and `(bindingId, sequence)` assignments.
6. Start one STT utterance and forward actual owner PCM once.

Changing one non-empty selection to another while an utterance is active applies
only to the next utterance. The current capture uses its snapshot.

`Input off` is the safety exception. It immediately:

- stops forwarding PCM;
- sends activity end/finalization cancellation as appropriate;
- discards the unfinished transcript;
- records a metadata-only dropped outcome for every allocated binding sequence;
- requires a fresh mute/unmute before later capture.

Removing a snapshotted binding before final commit drops only that binding's
assignment. Other valid targets still commit.

### 5.6 Fan-out

- Fan-out is off by default.
- The owner explicitly arms it on the card.
- The card displays `⚠️ FAN-OUT ×N` whenever several targets are selected.
- At most five targets may be selected.
- One capture produces one STT final and one audio-duration measurement.
- Commit creates one durable segment per still-valid target with:
  - the same `captureId` and `fanoutGroupId`;
  - binding-local sequence;
  - the same authenticated author and transcript;
  - a proportional/reference audio duration that is not summed for STT billing.
- Every binding proceeds independently. An idle target may dispatch while a
  busy target continues buffering.
- Agent and TTS costs may multiply by selected target count; the card states
  this explicitly.
- Fan-out selection and armed state persist across restart.
- Turning fan-out off while several targets are selected opens a required
  `Keep which input target?` selector. State does not change until one target is
  chosen or the action is cancelled.

## 6. User experience and slash surface

The existing `/seam voice` group expands from three to seven subcommands. It
remains well below the group's 25-option budget.

### 6.1 `/seam voice start`

Creates a console and its first binding from the current ACP thread.

Optional parameters:

- `alias`: presentation label; defaults to the thread title with a unique suffix
  if needed.

Rules:

- same V1 admin, guild, owner-in-VC, visible-channel, and self-muted checks;
- refuses an incompatible guild voice lease;
- if this guild already has a console owned by the invoker, direct them to
  `/seam voice add` rather than creating another;
- auto-assign an unused Gemini voice where possible;
- snapshot the current thread's TTS voice, pace, and style as the binding's
  independent console profile;
- select the first binding and enable its output;
- post the canonical card in this thread.

### 6.2 `/seam voice add`

Adds the current ACP thread to the owner's active console.

Optional parameters:

- `alias`;
- `claim` boolean, default true.

Rules:

- same guild, owner/admin, accessible thread, unique active thread binding, and
  ten-binding cap;
- does not open another Discord/STT connection;
- output defaults enabled;
- profile is copied from this thread's current TTS settings, then becomes
  console-local;
- claim behavior follows section 5.4 and applies to the next utterance if one is
  active.

### 6.3 `/seam voice remove`

Removes the current thread's binding.

Optional parameter:

- `discard-pending`, default false.

Rules:

- cancel this binding's current and queued speech promptly;
- do not cancel its ACP turn;
- preserve and normally dispatch finalized pending text by default;
- explicit discard follows the V1 artifact-free boundary;
- active/batched work already owned by a durable dispatch artifact is preserved;
- remove the binding from input targets and output scheduling atomically;
- if this is the control-thread binding and another binding remains, rehome the
  canonical card to the oldest remaining accessible binding before completing
  removal;
- removing the last binding ends the console and releases the voice lease.

### 6.4 `/seam voice configure`

Configures the current binding without changing ordinary thread TTS settings.

Optional parameters:

- `alias`;
- `voice` with autocomplete;
- `pace`;
- `style`.

Omitting all options opens an ephemeral binding editor with voice previews.
Aliases are 1–32 visible characters, unique case-insensitively within the
console, and sanitized for control characters/mentions. Duplicate TTS voices
are allowed only after a warning; the default assignment avoids duplicates.

### 6.5 `/seam voice console`

Returns the canonical card jump link.

Optional parameter:

- `repost`, default false.

With `repost:true`, create a replacement card in the current bound thread,
atomically update the control-thread/message ids, disable the old card when
possible, and increment the console revision. Use this when the original card
was deleted, archived, or inaccessible.

### 6.6 `/seam voice status`

Shows:

- console id, owner, VC, runtime, uptime, and connection state;
- actual STT-forwarded audio duration;
- selected input bindings and fan-out state;
- every binding's alias, thread, TTS voice, input/output indicators, ACP state,
  pending counts, and current speech state;
- global scheduler source/current queue depth;
- voice lease holder;
- control-card link and revision.

The canonical card shows the concise form. Slash status may post a paginated
ephemeral diagnostic when details exceed Discord limits.

### 6.7 `/seam voice stop`

Ends the entire console.

Optional parameter:

- `discard-pending`, default false and applied to every binding.

Stop:

- disables capture;
- stops STT and all current/queued VC speech;
- leaves/destroys the Discord voice connection;
- marks the console and bindings terminal;
- releases only this console's guild lease;
- preserves finalized pending text and durable dispatch work by default;
- edits the canonical card to a terminal state with components disabled.

## 7. Canonical control card

### 7.1 Location and identity

- Exactly one canonical live card exists per console.
- The start thread is initially the control thread.
- Other bound threads receive one compact notice with console alias/state and a
  jump link, not a second control plane.
- `/seam voice console repost:true` can rehome the card.
- Card authority uses immutable ids and revision, never visible labels.

Custom ids use a compact shape such as:

```text
tvc:<consoleId>:<revision>:<action>
```

Select values contain binding ids. Keep custom ids under Discord's 100-character
limit.

### 7.2 Card content

The embed shows:

- title `🎛️ Shared Voice Console`;
- owner and VC;
- console state and STT-forwarded duration;
- input state: `Off`, one alias, or `⚠️ FAN-OUT ×N`;
- global output state and current speaking alias/voice;
- one line per binding on the current page:
  - input selected indicator;
  - output enabled indicator;
  - alias and thread mention;
  - voice;
  - ACP/pending/speech state;
- cost warning when fan-out is active;
- footer with page, revision, and last update.

Display five bindings per page. The input/output selectors still contain all
active bindings because V2 caps the console at ten.

### 7.3 Component rows

Use five classic Discord action rows:

1. **Input target selector**
   - fan-out off: exactly one value;
   - fan-out armed: one through five values;
   - selected defaults mirror durable state.
2. **VC output selector**
   - values represent the complete enabled set;
   - allows independent output toggles;
   - explicit all-off remains available if clearing all values is awkward in a
     client.
3. **Configure binding selector**
   - opens an ephemeral alias/voice/pace/style editor and voice previews.
4. **Safety/convenience buttons**
   - `Input off`;
   - `Arm/Disarm fan-out`;
   - `Output all on`;
   - `Output all off`.
5. **Navigation/lifecycle buttons**
   - previous/next page when needed;
   - refresh;
   - end-console confirmation.

The end action requires a second explicit confirmation and never defaults to
discarding pending text.

### 7.4 Interaction transaction rules

For every component interaction:

1. Authenticate Discord user id as owner/admin.
2. Parse console id, revision, action, and immutable binding ids.
3. Load the active console and verify card message id when available.
4. Reject a stale revision with an ephemeral `Console changed; refresh` reply.
5. Validate selection counts, active bindings, same-console ownership, and
   permissions.
6. Apply state and increment revision in one SQLite transaction.
7. Acknowledge within Discord's deadline.
8. Edit the canonical card through one per-console serialized update queue.

Duplicate/retried interaction ids must be idempotent. An interaction may not
partially update the input target set.

The revision increments only for durable control-plane mutations (targets,
fan-out, output preferences, profiles, bindings, card location/page, or
lifecycle). Runtime status refreshes such as `speaking` or queue counts edit the
card without incrementing revision, so ordinary telemetry does not constantly
invalidate valid controls.

## 8. State model

### 8.1 Console states

```text
starting -> ready -> stopping -> ended
```

Any active state may enter `failed`. Observable runtime substates include:

- input off;
- muted/ready;
- capturing;
- transcribing;
- speaking;
- reconnecting;
- awaiting safe mute.

### 8.2 Binding states

```text
adding -> active -> removing -> ended
```

A binding may be `failed` without killing the console or other bindings.
Derived activity includes idle, pending input, agent working, speech queued,
speaking, and output disabled.

### 8.3 Input state

Input state consists only of:

- `fanoutArmed` boolean;
- ordered selected binding-id set;
- console revision;
- `awaitingSafeMute` runtime flag.

The selected set is empty, one id, or at most five ids. When fan-out is false,
the durable set may contain at most one id.

### 8.4 Output state

Each active binding stores `outputEnabled`. The console derives:

- all on;
- partially enabled;
- all off.

There is no paused-audio state. Disabled output is dropped.

## 9. Capture, transcription, and billing

### 9.1 Shared capture path

One Discord receiver/capture gate serves the console owner. One Gemini Live
Transcribe client serves at most one logical utterance at a time.

Reuse the V1 contracts:

- Discord 48 kHz Opus decode;
- downsample to 16 kHz mono PCM;
- Gemini 3.5 Live Transcribe in Text/Smart mode;
- manual activity start/end;
- custom vocabulary normalization;
- five-minute continuation parts;
- exact-boundary terminal handling;
- bounded Live finalization with unary fallback;
- exactly-one winner between late Live final and unary result;
- idle/GoAway/session-age rotation;
- no PCM persistence.

### 9.2 No-audio states

Do not forward PCM when:

- input target set is empty;
- owner is self-muted;
- no valid unmute edge armed the utterance;
- owner is not the console owner;
- owner disconnected or changed VCs;
- capture was cancelled by Input off;
- every snapshotted binding became invalid.

Keeping the WebSocket open during silence is permitted, but transmitted-byte
telemetry—not wall-clock connection time—is the audio usage authority.

### 9.3 Continuations and fan-out ordering

One logical utterance may contain multiple five-minute STT parts. All parts
retain one capture id and the same target/sequence assignments. The exact-size
empty terminal marker finalizes usable continuation text once; it never creates
an empty prompt.

Binding-local sequence allocation at the unmute edge preserves ordering even
when two finals complete out of API order or one target is busy.

### 9.4 Telemetry

Store on the console:

- actual forwarded PCM bytes/duration;
- utterance count;
- live-final count;
- unary-fallback count;
- dropped/noise count;
- STT failure count.

Do not multiply STT duration by fan-out target count. Binding diagnostics may
reference a capture duration but billing totals live only on the console.

## 10. Durable input and ACP dispatch

### 10.1 Per-binding segments

Each valid target receives its own `thread_voice_segments` row. Existing V1
segment states and artifact rules remain unchanged.

Add nullable fields:

- `binding_id` or reuse the legacy session id as binding authority;
- `capture_id`;
- `fanout_group_id`.

For non-fan-out captures, `fanout_group_id` may be null. Never store PCM, Opus,
WAV, Ogg, base64 audio, or signed audio URLs.

### 10.2 Independent release

Each binding has an independent pending buffer and release loop.

A binding is busy while:

- its Discord thread channel queue is occupied;
- its Thread Voice dispatch is active;
- its ACP agent turn is active;
- that binding still has required speech chunks queued/playing.

Other bindings' ACP turns or speech do not make this binding busy. Global audio
serialization may delay this binding's own drain, but it cannot prevent another
binding from dispatching text if that other binding is independently idle.

### 10.3 Fan-out dispatch

- Claim and enqueue one durable dispatch per binding.
- Use different stable dispatch ids and the binding id as trusted Thread Voice
  metadata.
- Verify console owner, binding, target thread, and durable batch before
  injecting the authenticated speaker.
- Echo one concise finalized transcript in every receiving thread, marked as
  fan-out when more than one target received it.
- A failure in one binding does not roll back another binding's committed
  segment or dispatch.

### 10.4 Crash recovery

Retain the V1 artifact protocol:

- claimed rows have a stable `tvd_*` id;
- reconcile missing/pending/running/done dispatch artifacts;
- never enqueue a second ACP turn for one batch;
- a running turn resumes through existing turn recovery;
- discard never deletes work owned by a durable artifact.

Recovery iterates bindings independently after console/card reconciliation.

## 11. Binding-local TTS profiles

Each binding stores:

- Gemini voice;
- pace;
- style;
- profile update timestamp.

At binding creation, copy the thread's effective TTS profile. Subsequent
`/seam config tts` changes do not change the binding profile, and console
configuration does not change ordinary thread TTS.

Automatically choose an unused voice when possible. Different voices are the
normal source-attribution mechanism. Do not speak “Kanoa thread says” before
responses. The console card is the visible alias-to-voice map.

Duplicate voices are allowed after an explicit warning because the Gemini
catalog is finite and the owner may prefer them. The card displays duplicates.

## 12. Global progressive speech scheduler

### 12.1 Inputs

Every voice-enabled binding/ACP turn owns a streaming speech segmenter using
the V1 rules:

- paragraph boundary may release;
- sentence boundary at/after the minimum target may release;
- force near the maximum safe length;
- flush the final tail;
- exclude code fences, tool output, directives, and hidden protocol text.

This includes ordinary typed, voice-authored, wake, and trusted injected turns
that use the thread's visible response path. It does not make isolated/silent
work audible.

The segmenter emits ordered source chunks:

```text
{ consoleId, bindingId, turnId, ordinal, text, generation }
```

### 12.2 Scheduler guarantees

- One global scheduler and one Discord audio player per console.
- Never overlap bot audio.
- Preserve chunk order within each binding/turn.
- Use binding-local voice/pace/style per synthesis request.
- Keep one Gemini TTS request in flight globally in V2.
- Synthesize just in time rather than pre-synthesizing an unbounded backlog.
- Begin playback as soon as the first chosen chunk completes synthesis.

### 12.3 Fairness

Use round-robin among ready enabled sources. A source may retain the scheduler
until either:

- two chunks complete; or
- 25 seconds of its audio completes,

whichever comes first. If another source is ready, rotate at the next chunk
boundary. If none is ready, continue the current source.

Never interrupt a chunk merely to satisfy fairness. A voice change identifies
the new source. Source aliases remain visible on the card.

### 12.4 Output toggle behavior

Disabling one binding's output:

- increments its speech generation;
- cancels/ignores that source's in-flight synthesis result;
- stops its currently playing chunk promptly;
- removes its queued chunks;
- allows the scheduler to continue with another source;
- does not abort ACP, hide text, change input targets, or discard voice input.

Already submitted TTS work may still cost money. Do not submit new work while
disabled.

Output disabled is drop, not pause. Re-enabling speaks only future complete
chunks. If re-enabled during a streaming turn, resume at the next clean chunk
boundary; never read the disabled backlog.

`Output all off/on` applies the same operation transactionally to every active
binding. It does not change input state.

### 12.5 Completion and next input

ACP completion does not settle a binding's voice turn until all chunks that
were accepted while output was enabled have played, failed, or been explicitly
dropped by a toggle/cancel.

Once that binding settles, its next pending voice batch may release even if
other bindings still have agent or speech work.

### 12.6 Speech failures

- One chunk failure posts at most one concise warning in that source thread per
  turn and continues with later chunks.
- Text remains successful.
- A failed source cannot stall the global scheduler.
- No completed-turn native voice-message fallback runs for an active binding,
  even when VC output is disabled. This avoids duplicate cost/artifacts and
  keeps output-off truly quiet.
- Voice connection loss drops all speech, preserves text/pending input, and
  ends or reconnects the console according to recovery policy.

## 13. Persistence and migration

### 13.1 `voice_console_sessions`

Add a durable console table with:

- id, primary key (`tvc_*`);
- platform;
- guild id;
- voice channel id;
- owner user id and presentation name snapshot;
- status;
- control thread ref and parent ref;
- control message id;
- card page;
- revision;
- fan-out armed;
- forwarded audio bytes/ms and STT counters;
- created/updated/ended UTC;
- end reason.

Constraints:

- one active console per guild;
- active lookup by owner and VC;
- revision is monotonic.

### 13.2 Evolve `thread_voice_sessions` as bindings

Preserve the existing table and segment foreign keys to avoid transcript-history
migration. Add:

- `console_id`, nullable for historical V1 rows;
- `alias`;
- `tts_voice`;
- `tts_pace`;
- `tts_style`;
- `output_enabled`;
- binding lifecycle timestamps/reason as needed.

At the TypeScript boundary, call active V2 rows `ThreadVoiceBinding` even though
the compatibility table retains its old name.

Replace the V1 one-active-session-per-guild index with:

- one active binding per `(platform, channel_ref)`;
- unique active alias per console using normalized alias;
- active lookup by console;
- console table owns the one-active-console-per-guild constraint.

Do not delete or rewrite terminal V1 rows.

### 13.3 `voice_console_input_targets`

Use a normalized table:

- console id;
- binding id;
- selected ordinal;
- selected UTC.

Primary key `(console_id, binding_id)`. Selection replacement, fan-out
validation, console revision increment, and target removal happen in one
transaction.

### 13.4 Segment additions

Add nullable:

- `capture_id`;
- `fanout_group_id`.

The existing `session_id` remains the binding row id for compatibility.

### 13.5 Active V1 upgrade

Migration/reconciliation must support deploying while one V1 session is active:

1. Create one console row from the active V1 row.
2. Point that row to the new console and backfill alias/profile/output enabled.
3. Select it as the single input target with fan-out off.
4. Transfer/reacquire the guild `thread_voice` lease using the console id.
5. Reconnect with the V1 fresh-safe-mute rule.
6. Reuse the existing notice as a terminal/link notice and post the console card.

This operation is idempotent across repeated startup attempts.

## 14. Lifecycle and recovery

### 14.1 Startup ordering

1. Open/migrate SessionStore.
2. Reconcile durable Live Help rows and voice lease intent.
3. Construct the Voice Console manager, router, scheduler, and card handler.
4. Upgrade/reconcile active V1 rows.
5. Reconcile active console and bindings while dispatch watcher is stopped.
6. Reconnect Discord/STT only when the owner/VC state is safe.
7. Recover binding dispatch artifacts.
8. Start the dispatch watcher.
9. Refresh or recreate the canonical card.

The watcher must not consume a Thread Voice dispatch before binding verification
and settlement callbacks are installed.

### 14.2 Reconnect safety

- Owner present in the same VC and muted: reconnect ready.
- Owner present but unmuted: reconnect, set `awaiting safe mute`, forward no PCM
  until mute then a later unmute.
- Owner temporarily absent: use the existing 30-second grace.
- Owner returns during grace: preserve console and bindings, still require a
  fresh safe mute cycle.
- Grace expires or VC is unavailable: end console, preserve durable text, and
  release the lease.

### 14.3 Card recovery

- If the message exists, edit it in place to current durable state.
- If missing in an accessible control thread, recreate once and update message
  id/revision.
- If the control thread is inaccessible, keep the console live and instruct the
  owner through `/seam voice status` to run
  `/seam voice console repost:true` from another binding.
- Old card components become stale through revision/message validation.

### 14.4 Shutdown

Drain/stop capture and speech, persist terminal/reconnectable state according to
the existing redeploy policy, release runtime listeners/timers/WebSockets, and
never discard durable text merely because the process exits.

## 15. Cancellation and coexistence

- Plain `/seam cancel` cancels the ACP turn in that text thread only. It does not
  stop the console or discard pending voice text.
- `/seam cancel force:true` additionally cancels that binding's current/queued
  speech but leaves the console and other bindings running.
- `/seam cancel scope:all` stops all consoles and Live Help sessions as part of
  the existing privileged global cancellation path; finalized text is preserved.
- `/seam queue` is rejected only in a thread whose binding has pending/batched
  Thread Voice text. Another bound thread with no buffered voice text retains
  normal queue behavior.
- Typed messages keep their normal generation bump/interrupt semantics in their
  own thread. They do not erase pending voice segments.
- Live Help and Voice Console cannot coexist in the same guild. A conflict
  names the active kind and console/session id, never an authorization or parent
  approval failure.
- Student Live Help self-service remains unchanged.

## 16. Privacy, security, and observability

### 16.1 Privacy

- No raw/encoded audio persistence.
- Only finalized transcript text and metadata enter SQLite/dispatch artifacts.
- Do not log full transcripts, PCM, file bodies, or signed media URLs.
- Card/status presentation sanitizes aliases and owner names.

### 16.2 Trusted speaker metadata

Internal Thread Voice dispatch metadata must verify:

- console is active or the batch is a preserved post-stop artifact;
- binding id owns the target thread;
- author id matches durable console owner;
- batch segments belong to the binding and dispatch id;
- non-Thread-Voice dispatch kinds cannot carry these fields.

Speaker/current-author state exists only during the verified turn and is cleared
in every terminal path.

### 16.3 Metrics/logs

Structured metadata may include:

- console id, binding id, guild, VC, owner id;
- revision and selected target count;
- fan-out group id and target count, without transcript text;
- forwarded PCM bytes/ms;
- STT outcome/latency;
- per-binding pending/dispatch counts;
- TTS synthesis/play latency, scheduler source switches, and drops;
- component action name and stale/refused outcome;
- cleanup/lease/reconnect reason.

Status must distinguish shared STT usage from potentially multiplied ACP/TTS
work.

## 17. Failure behavior

- One binding failure does not terminate other bindings unless the shared
  Discord/STT transport failed.
- STT Live failure uses unary fallback once; late losers cannot duplicate
  segments across any target.
- A fan-out commit failure is retried/recorded per binding. Successful commits
  remain successful.
- A stale/invalid card interaction changes nothing.
- Card edit failure does not change already committed routing state.
- TTS failure never fails the ACP turn or blocks the scheduler.
- Output toggle races use generation checks so late synthesis cannot play.
- Binding removal races establish the V1-style release/discard barrier before
  deleting target membership.
- Console stop waits for in-flight release inspection before optional discard.
- Shared transport loss preserves finalized text and marks unfinished captures
  dropped.
- Every cleanup path is idempotent and releases only its own lease/listeners.

## 18. Acceptance criteria

### 18.1 Console and bindings

- Start creates one console, one binding, one lease, one voice connection, and
  one canonical card.
- Add creates another binding without another Discord/STT connection.
- Ten bindings succeed; the eleventh is refused precisely.
- Same thread cannot be bound twice.
- Remove one binding leaves the console and others running.
- Removing the last binding ends the console.
- Stop ends all bindings and releases the lease.

### 18.2 Card authorization and durability

- Only owner/admin component actions succeed.
- Custom ids/values use immutable ids.
- Stale revision and old-message interactions change nothing.
- Duplicate component delivery is idempotent.
- Restart restores targets, fan-out state, output toggles, profiles, page, and
  card.
- Repost safely invalidates the old card.

### 18.3 Input safety

- Input off sends zero PCM and creates no transcript.
- Unmute alone sends no PCM and interrupts nothing.
- Enabling input while already unmuted requires mute then unmute.
- Non-owner packets are never forwarded.
- Mid-utterance target changes apply next utterance.
- Input off mid-utterance aborts and records terminal dropped sequences.
- Reconnect unmuted requires a fresh safe mute cycle.

### 18.4 Focus and fan-out

- Focused utterance commits to exactly one selected binding.
- Fan-out commits identical text once per selected valid binding with one group
  id and one STT usage measurement.
- Fan-out target cap is five.
- Turning fan-out off with several targets requires selecting the one to keep.
- Busy/idle fan-out targets dispatch independently.
- Removed/invalid target is skipped without blocking valid targets.
- Transcript wording never changes destinations.

### 18.5 Durable dispatch

- Per-binding capture order is preserved when API finals race.
- A claimed batch receives one stable artifact/ACP turn across crash recovery.
- Typed interruption and cancel behavior remain thread-local.
- Discard cannot race a stale in-memory release into enqueueing text.
- Pending text survives remove/stop/restart by default.

### 18.6 Speech profiles and scheduler

- Binding profiles do not mutate ordinary TTS config and vice versa.
- Distinct binding voices are used per request.
- Audio never overlaps.
- Per-binding chunk order is preserved.
- Ready sources rotate after two chunks or 25 seconds at a clean boundary.
- Output-off cancels/drops that source only and does not pause ACP.
- Re-enable speaks future chunks only.
- Global output-off leaves input targets unchanged.
- Binding settlement waits for its own accepted speech drain, not unrelated
  sources.
- Native completed-turn voice messages remain suppressed while bound.

### 18.7 Recovery, privacy, and regression

- Active V1 session upgrades idempotently to one console/binding.
- Missing card recreates without duplicate live cards.
- Shared transport cleanup leaves no receiver subscriptions, players, timers,
  WebSockets, scheduler sources, manager entries, or leases.
- SQLite, dispatch files, logs, and `DATA_DIR` contain no raw audio.
- Live Help student self-service remains green.
- Voice-note STT remains Smart/custom-vocabulary.
- V1 single-thread behavior is representable as a one-binding console.
- Existing typed turns, queue, TTS attachments outside a console, and dispatch
  recovery remain green.

## 19. Implementation packages

Use `wt` worktrees and keep central integration files owned by one package.
Every worker must read this full specification and the repository `AGENTS.md`.

### Package A — console core, schema, migration, and binding manager

**Suggested branch:** `feat/voice-console-core`

**Owns:**

- new `packages/core/src/core/voice-console/types.ts`;
- new `packages/core/src/core/voice-console/manager.ts`;
- `packages/core/src/core/session-store.ts` migrations/store methods;
- additive updates to `packages/core/src/core/voice-lease.ts` only if required;
- focused store/manager/migration tests.

**Responsibilities:**

- console/binding/input-target types and ids;
- durable CRUD and active constraints;
- revisioned transactional card state;
- target snapshot and per-binding sequence allocation;
- fan-out commit and independent release coordination;
- binding remove/console stop discard barriers;
- active V1 upgrade;
- boot reconciliation contracts;
- no Discord imports.

**Exit gate:** focused tests, typecheck, full build; no orchestrator/commands edit.

### Package B — shared capture router and STT fan-out coordinator

**Suggested branch:** `feat/voice-console-capture`

**Owns:**

- new `packages/core/src/core/voice-console/capture-router.ts`;
- new Discord host/coordinator modules under
  `packages/core/src/platforms/discord/voice-console-capture.ts`;
- narrowly scoped additive changes to `thread-voice-host.ts` if reuse requires;
- mocked capture/STT tests.

**Responsibilities:**

- input-off and fresh-safe-mute gating;
- immutable target snapshots;
- one STT utterance/continuation chain per capture;
- one final fanned into binding-local results;
- input-off mid-capture cancellation;
- forwarded-byte authority and no-audio states;
- exactly-once Live/unary arbitration across fan-out.

**Do not change:** Gemini wire contract unless a test proves a V1 defect.

### Package C — source-aware global speech scheduler

**Suggested branch:** `feat/voice-console-speech`

**Owns:**

- new `packages/core/src/core/voice-console/speech-scheduler.ts`;
- new scheduler/source types and tests;
- source-aware additions to
  `packages/core/src/platforms/discord/thread-voice-call.ts` or an extracted
  `voice-console-playback.ts`;
- focused TTS cancellation/fairness/playback tests.

**Responsibilities:**

- global one-request synthesis scheduling;
- per-source ordering and two-chunk/25-second fairness;
- binding-local TTS profiles;
- output generation invalidation;
- prompt stop/drop/re-enable semantics;
- per-binding drain promises;
- reusable player and idempotent teardown.

**Do not edit:** orchestrator, commands, SessionStore.

### Package D — canonical card and binding editor

**Suggested branch:** `feat/voice-console-card`

**Owns:**

- new `packages/core/src/platforms/discord/voice-console-panel.ts`;
- new `packages/core/src/platforms/discord/voice-console-components.ts`;
- card rendering, custom-id, pagination, and interaction-parser tests.

**Responsibilities:**

- five-row card layout;
- immutable ids/revisions;
- selectors and confirmation views;
- concise/paginated status presentation;
- alias/profile editor and voice previews;
- no persistence mutation or orchestrator wiring.

Define card-local render/component types inside the new modules. Do not edit
`adapter.ts`, `orchestrator.ts`, `commands.ts`, or shared `core/types.ts` in this
package; Package E owns any final adapter/generalization work.

### Package E — serialized integration and command cutover

**Suggested branch:** `feat/thread-voice-v2`

**Owns all central integration files:**

- `packages/core/src/platforms/discord/orchestrator.ts`;
- `packages/core/src/platforms/discord/commands.ts`;
- `packages/core/src/platforms/discord/adapter.ts`;
- process construction/startup/shutdown wiring;
- dispatch schema/verification integration;
- operator/agent guide and `AGENTS.md` updates;
- integration tests.

**Responsibilities:**

- merge/adapt Packages A–D;
- slash lifecycle and authorization;
- component interaction transactions;
- per-binding ordinary turn routing;
- card update queues;
- speech segmenter/source registration;
- Live Help lease/recovery ordering;
- queue/cancel/typed-turn coexistence;
- V1 command behavior represented through one-binding console;
- no live Discord probe.

Only Package E edits the high-conflict central files.

### Package F — adversarial QA and hardening

**Suggested branch:** `qa/thread-voice-v2`

**Starts after:** Package E integration tip

**Scope:** deterministic tests first; implementation edits only for reproduced
blockers.

Required adversarial areas:

- simultaneous/stale card mutations and duplicate interactions;
- input-off race with PCM/finalization;
- target change/remove race during capture;
- fan-out partial failure and capture-order races;
- stop/discard/release/artifact races;
- output-off during synthesis/playback and rapid re-enable;
- fairness under long/noisy and short sources;
- typed interruption in one binding while others run;
- process restart between every claim/artifact/card transition;
- Live Help lease races and student self-service regression;
- privacy/resource-leak audit.

**Exit gate:** focused suite, typecheck, build, full test suite, diff audit, no
deployment/live voice.

## 20. Merge and delegation order

1. Freeze this specification and create one foundation worktree from current
   `main`.
2. Run Packages A, B, C, and D in isolated `wt` worktrees where file ownership
   does not overlap.
3. Review each package independently and land its commit onto the integration
   branch in order A -> B -> C -> D.
4. Run Package E only after the combined foundation builds and focused package
   tests pass.
5. Give Package F the exact Package E tip.
6. Fix every P0/P1 invariant before merge.
7. Merge/push to `main` only after the exact candidate tree passes typecheck,
   build, full tests, and `git diff --check`.
8. Use `npm run redeploy`, never direct PM2 restart.
9. Perform a controlled live probe only with fresh owner consent.

## 21. Controlled live probe

After all automated gates pass:

1. Owner joins a throwaway VC and self-mutes.
2. Start console in thread A; verify one connection/card and zero audio usage.
3. Add threads B and C; verify no additional connection/STT client.
4. Stay muted for 60 seconds; forwarded duration remains zero.
5. Select A, unmute/speak/mute; only A receives one prompt.
6. Arm fan-out and select A+B; one utterance produces one STT final and one
   authenticated prompt in each target.
7. While A and B answer, verify distinct voices and no overlapping audio.
8. Generate long A output and short B output; verify fairness rotation only at
   chunk boundaries.
9. Disable A output mid-chunk; A stops promptly, B continues, A text remains.
10. Speak to B while its prior turn/playback is active; follow-up waits and then
    dispatches once.
11. Set Input off while unmuted; verify immediate capture discard and zero later
    commit. Re-enable while still unmuted; verify no capture until mute/unmute.
12. Remove B and verify A/C remain live.
13. Stop console preserving pending text; verify connection/lease/card cleanup.
14. Inspect SQLite, dispatch artifacts, logs, and `DATA_DIR` for duplicate turns,
    raw audio, or leaked resources.

Abort immediately on non-owner capture, unmute-only interruption, hidden routing,
duplicate fan-out dispatch, overlapping bot audio, stale-card mutation, raw-audio
persistence, or a leaked guild voice lease.

## 22. Definition of done

V2 is done when one admin can operate a durable, card-controlled, multi-thread
Voice Console in one Discord VC; explicitly focus or fan out microphone input;
hear serialized, distinguishable, independently mutable thread responses; and
restart, remove, cancel, or stop without duplicate turns, lost finalized text,
hidden routing state, raw-audio persistence, or regression of Live Help/V1 text
behavior.
