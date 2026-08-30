# Thread Voice V2 — Shared Voice Console specification

**Status:** Product decisions locked; ready for implementation planning

**Owner:** Jesse

**Date:** 2026-08-28

**Depends on:** shipped Thread Voice V1 and its independently verified durability, STT, dispatch, and TTS contracts

**Scope:** advanced/admin-operated Shared Voice Console; card-based routing only

## 1. Decision summary

Thread Voice V2 replaces the one-thread/one-call V1 runtime with one
guild-scoped **Shared Voice Console**. The console owns the guild's single
Discord voice connection, a user-keyed capture router, lazy per-speaker Gemini
Live Transcribe clients, one canonical Discord control card, and one global
speech scheduler.

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

- one authenticated admin control owner;
- every Discord user in `DISCORD_ALLOWED_USER_IDS` may speak through the
  console while present in its VC;
- each authorized speaker's self-mute edges define their utterance boundaries;
- merely unmuting does not interrupt playback and does not dispatch anything;
- only actual PCM from an authorized speaker inside that speaker's armed
  utterance reaches STT;
- speech received while a target is busy becomes that target's durable next
  prompt and never steers or aborts the current turn;
- text output remains authoritative when speech fails;
- no raw audio is persisted;
- Live Help and Thread Voice remain mutually exclusive through one guild voice
  lease.

## 2. Goals

V2 must:

1. Let one admin owner bind several Discord ACP threads to one voice channel.
2. Let several Seam-authorized Discord identities speak, including overlapping
   speakers, while preserving actual user attribution.
3. Let the owner choose input destinations explicitly from one persistent card.
4. Support deliberate same-transcript fan-out without multiplying STT work.
5. Let each binding's voice output be muted or restored independently.
6. Use distinguishable, persistent TTS profiles instead of spoken thread labels.
7. Serialize all bot audio while preventing one noisy binding from monopolizing
   playback.
8. Preserve independent ACP, pending-input, failure, and cancellation behavior
   for every binding.
9. Recover the console, card state, bindings, and durable text safely after a
   process restart.
10. Upgrade an active V1 session into a one-binding console during deployment.
11. Keep all card actions authenticated, versioned, durable, and visible.

## 3. Explicit non-goals

V2 does not include:

- spoken aliases, “switch to” commands, or LLM destination inference;
- compound spoken commands for different threads;
- physical-device identity, account-possession detection, or speaker diarization;
- family/student self-service authorization;
- barge-in, playback ducking, or speech-based ACP steering;
- overlapping bot audio or multiple Discord voice connections in one guild;
- persistent raw audio, recording, archives, or downloads;
- screen share, webcam, Discord Go Live, or image frames;
- replacing Gemini Live Help;
- automatic VC joining from a passive config flag;
- changing a thread's ordinary `/seam config tts` settings;
- more than ten bindings or more than five simultaneous fan-out targets;
- native completed-turn voice-message attachments while the thread is bound;
- a public/student control card.

## 4. Terminology

- **Voice Console:** the guild-level active product session that owns Discord
  voice, STT, capture routing, the control card, and global speech scheduling.
- **Control channel:** the console voice channel's built-in text chat, using the
  same Discord channel id as the voice connection. It contains the canonical
  console card.
- **Binding:** one immutable association between a console and an ACP home
  thread. A thread has at most one active binding in its guild.
- **Binding alias:** a short unique presentation label shown on the console.
  It is never parsed from speech and never used as an authority key.
- **Input target set:** the durable set of binding ids eligible to receive the
  next authorized-speaker utterance.
- **Input off:** an empty input target set. Audio is not forwarded to Google.
- **Fan-out armed:** the explicit mode allowing two through five input targets.
- **Capture snapshot:** the immutable binding-id and per-binding sequence set
  captured at one authorized speaker's valid unmute edge.
- **Authorized speaker:** a Discord user id present in the console VC and in the
  deployment's `DISCORD_ALLOWED_USER_IDS` set. This is evaluated independently
  from console-control authorization.
- **Speaker lane:** one user-id-keyed mute/capture/STT state machine. One user id
  has at most one logical utterance active, regardless of physical device.
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
  owner/control id.
- Only the console owner or another configured admin may operate the slash
  commands or card. A participant clicking a copied/stale component is refused.
- Capture eligibility is the existing `DISCORD_ALLOWED_USER_IDS` set used by
  Discord message ingress. It is checked at every unmute edge and again before
  final commit.
- Every allowed user currently in the console VC may speak. They do not need to
  be a config admin and do not gain card/command authority merely by speaking.
- Users absent from the allowlist are never subscribed, decoded, forwarded,
  transcribed, or persisted.
- Discord user id is the identity boundary. Several physical devices logged in
  as the same account remain one speaker lane and one author id. Detecting who
  physically possesses an authorized account/device is outside the threat model,
  exactly as it is for authenticated Discord chat.
- Every binding must be an existing ACP thread in the same guild and accessible
  to the bot.
- One console may have at most ten active bindings.
- One guild may have at most one active Voice Console or Live Help session.

### 5.2 Mute and speech safety

- The owner must be in the target VC and self-muted when creating the console.
- Each authorized speaker has an independent safe-mute state machine. Their
  self-mute-to-unmute edge only arms one utterance. It does not by itself send
  audio, interrupt playback, or create an input segment.
- Discord `speaking`/Opus packets supply audio only after that valid edge.
- Very short/noise-only captures remain dropped under the V1 threshold.
- Muting ends the utterance and asks STT to finalize.
- Authorized speech during agent work or playback queues input for selected
  bindings;
  it does not stop current work or audio.
- If input targets are enabled while a speaker is already unmuted, that speaker's
  capture stays disabled until a fresh mute followed by unmute. The card must say
  `Mute, then unmute to speak`.
- Joining, reconnecting, or changing device/voice session while unmuted has the
  same per-speaker fresh-mute requirement.
- A Discord voice-state or SSRC discontinuity for the same user id rebinds that
  user's existing lane; it does not create another identity or author. When the
  mute state cannot be proven continuous, that lane returns to `awaiting safe
  mute` before accepting more audio.
- Several authorized users may have armed/capturing lanes concurrently. Their
  PCM and transcripts are never mixed. Each final retains the Discord user id
  that produced it.

### 5.3 Card-only routing

- The card's durable input target set is the sole routing source.
- The target set is console-global, not per speaker. Every capture snapshots the
  selection at that speaker's own unmute edge, so two overlapping speakers can
  legitimately retain different snapshots if the card changes between edges.
- The console does not inspect transcript wording to choose a target.
- Aliases are display labels only.
- No hidden in-memory focus may diverge from the card.
- An unprefixed, prefixed, imperative, or ambiguous utterance is treated
  identically: it goes to the snapshotted target set.
- Destination changes are visible card interactions and durable before they
  can affect a later capture.

### 5.4 Input modes

- `Input off`: zero targets; all participant PCM is dropped locally and STT
  receives no audio.
- Focused: exactly one target; the normal mode.
- Fan-out: two through five targets while fan-out is explicitly armed.
- The first binding created with a console is selected automatically.
- `/seam voice add` claims the added binding by default:
  - fan-out off: it replaces the previous selected binding;
  - fan-out armed: it joins the target set if the five-target cap allows it.
- The add command exposes `claim:false` for adding without changing targets.
- Any visible agent prose produced in an active bound thread is eligible for VC
  speech when that binding's output is enabled, whether the turn began from
  voice input, a typed message, a wake, a scheduled/watch turn, a generic
  dispatch, or a handoff/report-back. Hidden or silent turns remain silent.
- This rule applies even when a dispatch path bypasses the ordinary Discord
  incoming-message handler. All visible renderers must publish agent-text into
  one shared binding speech hook; handler choice must not determine audibility.

### 5.5 Capture snapshot and mid-utterance changes

At an authorized speaker's valid unmute edge:

1. Read the console and selected bindings in one transaction.
2. Refuse capture if the target set is empty.
3. Revalidate that each binding is active, owned by this console, and points to
   a valid thread.
4. Allocate one ordered sequence for every selected binding. Concurrent speakers
   are ordered by the server's transaction/edge arrival order.
5. Persist or retain a memory-only capture record containing one capture id,
   speaker id/name, the console revision, and `(bindingId, sequence)` assignments.
6. Start one STT utterance in that speaker's lane and forward that speaker's
   actual PCM once.

Changing one non-empty selection to another while an utterance is active applies
only to the next utterance. The current capture uses its snapshot.

`Input off` is the safety exception. It immediately:

- stops forwarding PCM;
- sends activity end/finalization cancellation as appropriate;
- discards the unfinished transcript;
- records a metadata-only dropped outcome for every allocated binding sequence;
- requires a fresh mute/unmute before later capture.

These operations apply to every currently active speaker lane.

Removing a snapshotted binding before final commit drops only that binding's
assignment. Other valid targets still commit.

### 5.6 Fan-out

- Fan-out is off by default.
- The owner explicitly arms it on the card.
- The card displays `⚠️ FAN-OUT ×N` whenever several targets are selected.
- At most five targets may be selected.
- One speaker capture produces one STT final and one audio-duration measurement.
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
- preflight the VC chat as a hard prerequisite. The bot must have
  `ViewChannel`, `Connect`, `SendMessages`, `EmbedLinks`, and
  `ReadMessageHistory` in that voice channel;
- refuse startup with the exact missing permissions when the VC chat is not
  usable. Never fall back to an ACP thread or another text channel;
- refuses an incompatible guild voice lease;
- if this guild already has a console owned by the invoker, direct them to
  `/seam voice add` rather than creating another;
- auto-assign an unused Gemini voice where possible;
- snapshot the current thread's TTS voice, pace, and style as the binding's
  independent console profile;
- select the first binding and enable its output;
- post the canonical card in the voice channel's built-in text chat and persist
  its message id.

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

Adding a binding never changes which people may speak; speaker eligibility is
always the deployment allowlist plus current VC presence.

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
- removing any binding leaves the canonical card in the VC chat;
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

With `repost:true`, create a replacement card in the console VC chat,
atomically update the card message id, disable the old card when possible, and
increment the console revision. The command may be invoked from any active
binding, but the replacement is always posted in the same VC chat. Use this when
the original card was deleted. If the VC chat is inaccessible, return the
permission error instead of relocating the card.

### 6.6 `/seam voice status`

Shows:

- console id, owner, VC, runtime, uptime, and connection state;
- authorized speakers currently present, each speaker's safe-mute/capture state,
  and concurrent active-lane count;
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
- It is always posted in the active voice channel's built-in text chat, whose
  channel id is already the console's `voiceChannelId`.
- A working VC chat is a product prerequisite. The server is expected to grant
  intended participants `ViewChannel`, `Connect`, and `ReadMessageHistory` so
  they can see the persistent card. This does not broaden card-control
  authorization beyond owner/admin.
- Other bound threads receive one compact notice with console alias/state and a
  jump link, not a second control plane.
- `/seam voice console repost:true` replaces it only in that VC chat.
- There is no thread fallback. Missing bot chat permissions refuse startup;
  permissions revoked during a console make the console inoperable and trigger
  the shared failure/cleanup path while preserving durable text.
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
- authorized speakers present and currently capturing speakers;
- an unauthorized-listener count when other users are present, without treating
  them as capture candidates or granting controls;
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

There is no speaker selector. Presence plus `DISCORD_ALLOWED_USER_IDS`
automatically determines capture eligibility; the card controls shared routing
and output only.

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
fan-out, output preferences, profiles, bindings, card message/page, or
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
- a runtime `speakerLanes` map keyed by Discord user id, with presence,
  subscription, mute-safety, capture, and STT state.

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

One Discord receiver serves the console. The capture router subscribes only to
currently present `DISCORD_ALLOWED_USER_IDS` members and maintains one logical
lane per Discord user id. Each active lane uses its own lazy Gemini Live
Transcribe client/utterance chain, so concurrent speakers remain separately
attributed without acoustic diarization.

For one user id, only one logical utterance may be active. If Discord moves that
account between SSRCs or devices, the transport rebinds the existing lane and
applies the safe-mute rule when continuity is uncertain. It must not duplicate
the lane, transcript, author, or forwarded-byte accounting.

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
- the packet's Discord user id is not in `DISCORD_ALLOWED_USER_IDS`;
- that authorized user is self-muted;
- no valid unmute edge armed that user's utterance;
- that user disconnected, changed VCs, or has an uncertain voice-state/SSRC
  transition awaiting a safe mute cycle;
- capture was cancelled by Input off;
- every snapshotted binding became invalid.

Unauthorized users are not subscribed or decoded in the first place. A final
allowlist check before commit protects against authorization being removed
during an utterance.

Keeping a lane's WebSocket open during silence is permitted, but
transmitted-byte telemetry—not wall-clock connection time—is the audio usage
authority.

### 9.3 Continuations and fan-out ordering

One logical utterance may contain multiple five-minute STT parts. All parts
retain one capture id and the same target/sequence assignments. The exact-size
empty terminal marker finalizes usable continuation text once; it never creates
an empty prompt.

Binding-local sequence allocation at the unmute edge preserves ordering even
when two finals complete out of API order or one target is busy.

This ordering spans speakers. The transaction that snapshots targets at each
unmute edge allocates binding-local sequence numbers; a later speaker's final
waits behind an earlier unresolved sequence. A terminal dropped/noise outcome
unblocks the sequence without creating an empty prompt.

### 9.4 Telemetry

Store on the console:

- actual forwarded PCM bytes/duration;
- utterance count;
- live-final count;
- unary-fallback count;
- dropped/noise count;
- STT failure count.

These are aggregate totals across all speaker lanes. Per-speaker counters may
be kept as metadata for diagnostics, without transcript text or audio.

Do not multiply STT duration by fan-out target count. Simultaneous speakers do
increase STT usage because each user's actual PCM is independently forwarded,
but each byte is counted exactly once regardless of target count. Binding
diagnostics may reference a capture duration but billing totals live only on
the console.

## 10. Durable input and ACP dispatch

### 10.1 Per-binding segments

Each valid target receives its own `thread_voice_segments` row. Existing V1
segment states and artifact rules remain unchanged.

Add nullable fields:

- `binding_id` or reuse the legacy session id as binding authority;
- `capture_id`;
- `fanout_group_id`.

The segment's existing authenticated author fields store the actual authorized
speaker id/name captured for that utterance, not the console owner. All rows in
one fan-out group carry the same speaker identity.

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
- Verify console, binding, target thread, captured author, and durable batch
  before injecting the authenticated speaker. Control ownership and prompt
  authorship are separate authorities.
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
- the first clean sentence boundary releases immediately, even below the old
  minimum target, so a short first sentence is not held until turn completion;
- force near the maximum safe length;
- flush the final tail;
- exclude code fences, tool output, directives, and hidden protocol text.

This includes ordinary typed, voice-authored, wake, and trusted injected turns
that use the thread's visible response path, plus generic dispatch and
handoff/report-back turns whose output is visibly streamed or posted into the
bound thread. It does not make isolated/silent work audible.

Package E must centralize a binding-aware `visible agent text -> speech source`
hook and invoke it from both the ordinary user-turn renderer and every generic
dispatch renderer. Status panels, dispatch headers, progress indicators,
report-back harness metadata, tool output, and duplicated terminal reposts are
not agent prose and must not be spoken. One visible text event is accepted by
the scheduler at most once.

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
- Request `gemini-3.1-flash-tts-preview` from the Interactions endpoint with
  `stream:true`, `store:false`, `Api-Revision: 2026-05-20`, and SSE response
  negotiation.
- Parse ordered `step.delta` audio events incrementally without logging event
  bodies, prompts, API keys, or base64 audio.
- The SSE parser accepts arbitrary byte fragmentation, CRLF, comments,
  multiline `data:`, unknown event types, explicit completion, and `[DONE]`;
  it fails closed on malformed/truncated events, explicit provider failure, or
  a response that reaches EOF without completion.
- Request the provider's canonical audio response and accept the model's
  documented 24 kHz mono PCM stream. Audio-delta metadata is optional; when
  present it must remain consistent with that contract and prior deltas. Reject
  URI-backed, compressed, incomplete, or conflicting audio before playback.
- Begin playback when the first validated 24 kHz mono L16 delta arrives; do not
  wait for interaction completion or response EOF.
- Keep the Discord producer open between network deltas, preserve partial PCM
  samples/Opus frames, and apply bounded audio buffering with producer
  backpressure.
- Never retry a synthesis request after any audio delta has been accepted by
  playback. Unary synthesis is permitted only after a clean streaming response
  completed with no accepted audio, so fallback cannot duplicate speech.
- Enforce both a whole-provider deadline and a network read-idle watchdog;
  cancellation also interrupts a producer blocked by playback backpressure.

### 12.3 Fairness

Use round-robin among ready enabled sources. A source may retain the scheduler
until either:

- two chunks complete; or
- 25 seconds of its audio completes,

whichever comes first. If another source is ready, rotate at the next chunk
boundary. If none is ready, continue the current source.

Never interrupt a chunk merely to satisfy fairness. A voice change identifies
the new source. Source aliases remain visible on the card.
Any airtime already consumed before a chunk fails or is cancelled still counts
toward that source's 25-second fairness slice.

### 12.4 Output toggle behavior

Disabling one binding's output:

- increments its speech generation;
- cancels/ignores that source's in-flight synthesis result;
- stops its currently playing chunk promptly;
- removes its queued chunks;
- allows the scheduler to continue with another source;
- does not abort ACP, hide text, change input targets, or discard voice input.

Already submitted TTS work may still cost money. Do not submit new work while
disabled. Cancellation closes the streaming response, clears buffered/current
PCM for that source generation, and fences every late delta.

Output disabled is drop, not pause. Re-enabling speaks only future complete
chunks. If re-enabled during a streaming turn, resume at the next clean chunk
boundary; never read the disabled backlog.

`Output all off/on` applies the same operation transactionally to every active
binding. It does not change input state.

### 12.5 Completion and next input

ACP completion does not settle a binding's voice turn until all chunks that
were accepted while output was enabled have played, failed, or been explicitly
dropped by a toggle/cancel.

The same drain boundary applies to generic dispatch and handoff/report-back
speech. Pending microphone input for that binding cannot release merely because
the injected ACP/dispatch turn completed while its visible speech is still
queued or playing.

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
- canonical card channel id, constrained to equal the voice channel id;
- canonical card message id;
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
9. Revalidate the VC chat permissions and refresh or recreate the canonical
   card there. If the permissions are absent, do not start the console runtime.

The watcher must not consume a Thread Voice dispatch before binding verification
and settlement callbacks are installed.

### 14.2 Reconnect safety

- Owner present in the same VC and muted: reconnect ready.
- Owner present but unmuted: reconnect, set `awaiting safe mute`, forward no PCM
  until mute then a later unmute.
- Every other authorized user already present is initialized independently:
  muted users are ready for a later unmute; unmuted users await a fresh
  mute/unmute cycle.
- An authorized user who joins later follows the same rule. Their departure
  closes only their lane and never ends the console.
- The owner still controls console lifetime. The existing owner-absence grace
  applies even if other authorized speakers remain; V2 does not transfer
  ownership implicitly.
- Owner temporarily absent: use the existing 30-second grace.
- Owner returns during grace: preserve console and bindings, still require a
  fresh safe mute cycle.
- Grace expires or VC is unavailable: end console, preserve durable text, and
  release the lease.

### 14.3 Card recovery

- If the message exists, edit it in place to current durable state.
- If the message was deleted, recreate it once in the same VC chat and update
  message id/revision.
- If the bot lacks `ViewChannel`, `Connect`, `SendMessages`, `EmbedLinks`, or
  `ReadMessageHistory`, recovery fails closed: do not reconnect capture or
  speech, mark/end the console through the shared terminal path, preserve
  finalized text, and release the lease.
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
- Discord VC membership controls who can hear the bot. Seam's speaker allowlist
  controls whose microphone audio it processes; it does not make unauthorized
  VC listeners unable to hear output.

### 16.2 Trusted speaker metadata

Internal Thread Voice dispatch metadata must verify:

- console is active or the batch is a preserved post-stop artifact;
- binding id owns the target thread;
- author id/name match the durable segment's captured speaker;
- the captured speaker was in `DISCORD_ALLOWED_USER_IDS` at capture and final
  commit;
- batch segments belong to the binding and dispatch id;
- non-Thread-Voice dispatch kinds cannot carry these fields.

The console owner remains the control authority and is not substituted as the
turn author. An allowed non-admin speaker receives no slash/card permissions.

Speaker/current-author state exists only during the verified turn and is cleared
in every terminal path.

### 16.3 Metrics/logs

Structured metadata may include:

- console id, binding id, guild, VC, control-owner id, and speaker id;
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

- One binding or speaker-lane failure does not terminate other bindings or
  speaker lanes unless the shared Discord transport failed.
- STT Live failure uses unary fallback once; late losers cannot duplicate
  segments across any target.
- A fan-out commit failure is retried/recorded per binding. Successful commits
  remain successful.
- A stale/invalid card interaction changes nothing.
- A transient card API error gets bounded retry/backoff and does not change
  already committed routing state or card location.
- Failure to verify/post the initial VC-chat card aborts startup before durable
  console creation or lease acquisition. A permission race after acquisition
  unwinds the partial runtime and lease.
- `Missing Access`, `Missing Permissions`, deleted VC, or persistently
  inaccessible VC chat never causes a thread fallback. During an active console,
  fail/stop safely, preserve durable text, and release the lease.
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
  one canonical card in the connected VC's built-in chat.
- Startup preflight refuses each missing required bot permission precisely and
  leaves no console row, binding, voice connection, or lease.
- Add creates another binding without another Discord/STT connection.
- Ten bindings succeed; the eleventh is refused precisely.
- Same thread cannot be bound twice.
- Remove one binding leaves the console and others running.
- Removing the last binding ends the console.
- Stop ends all bindings and releases the lease.

### 18.2 Card authorization and durability

- The canonical card's channel id always equals the console voice channel id;
  no ACP thread is a fallback card location.
- Every added/removed binding leaves the card in that VC chat.
- Each bound thread's compact notice jumps to the same VC-chat card.
- Only owner/admin component actions succeed.
- Custom ids/values use immutable ids.
- Stale revision and old-message interactions change nothing.
- Duplicate component delivery is idempotent.
- Restart restores targets, fan-out state, output toggles, profiles, page, and
  card.
- Repost safely invalidates the old card.
- Deleted card recovery recreates it once in the same VC chat.
- Revoked VC-chat permissions end/fail the console safely and preserve durable
  finalized text.
- Allowed non-admin speakers cannot mutate the card or use admin voice-console
  commands.

### 18.3 Input safety

- Input off sends zero PCM and creates no transcript.
- Unmute alone sends no PCM and interrupts nothing.
- Enabling input while already unmuted requires mute then unmute.
- Packets from users absent from `DISCORD_ALLOWED_USER_IDS` are never subscribed,
  decoded, forwarded, transcribed, or persisted.
- Two allowed users may overlap; each produces a separately attributed STT lane
  and durable author, with no mixed transcript.
- The same Discord user id across SSRC/device transitions remains one lane and
  one author, never duplicate capture.
- Removing a speaker from the allowlist during capture prevents final commit.
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
- Every dispatched Thread Voice prompt uses the segment's captured authorized
  speaker, not the console control owner.

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
- A visible generic dispatch or handoff/report-back response in a bound thread
  is spoken exactly once through that binding's profile and global scheduler.
- Dispatch headers/status panels/tool output are not spoken, and a quiet or
  hidden dispatch remains silent.
- Pending voice input waits for visible generic-dispatch speech to drain just as
  it does for an ordinary turn.

### 18.7 Recovery, privacy, and regression

- Active V1 session upgrades idempotently to one console/binding.
- Missing card recreates without duplicate live cards.
- Shared transport cleanup leaves no receiver subscriptions, players, timers,
  per-speaker WebSockets, speaker lanes, scheduler sources, manager entries, or
  leases.
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
- authenticated speaker identity on captures/segments and ordering across
  concurrent speakers;
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

- user-id-keyed receiver subscriptions and capture lanes;
- `DISCORD_ALLOWED_USER_IDS` gating at arm and final-commit boundaries;
- same-user SSRC/device rebind without duplicate identity;
- per-speaker input-off and fresh-safe-mute gating;
- immutable target snapshots;
- one lazy STT client and utterance/continuation chain per active speaker lane;
- one final fanned into binding-local results;
- concurrent authorized-speaker isolation, including overlapping speech;
- input-off mid-capture cancellation across every lane;
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
- incremental Interactions audio-delta parsing, bounded playback backpressure,
  and the no-retry-after-accepted-audio fence.

**Do not edit:** orchestrator, commands, SessionStore.

### Package D — canonical card and binding editor

**Suggested branch:** `feat/voice-console-card`

**Owns:**

- new `packages/core/src/platforms/discord/voice-console-panel.ts`;
- new `packages/core/src/platforms/discord/voice-console-components.ts`;
- card rendering, custom-id, pagination, and interaction-parser tests.

**Responsibilities:**

- five-row card layout;
- VC-chat-only location contract and permission-error presentation;
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
- fail-closed VC-chat permission preflight before lease/session creation;
- VC-chat card post/repost/recovery with no thread fallback;
- config-backed speaker authorization distinct from admin control ownership;
- actual-speaker trusted dispatch metadata and attribution;
- one shared binding speech hook used by ordinary and generic-dispatch renderers,
  including handoff/report-back, wake, scheduled, and watch turns;
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

- each missing VC-chat bot permission, permission revocation, card deletion,
  and transient API failure without relocation or leaked lease/state;
- visible generic dispatch/report-back speech, exactly-once renderer feeding,
  exclusion of headers/panels/tools, output-off silence, and playback-drain
  gating before pending voice release;
- two authorized speakers overlapping and finalizing out of order;
- same-user SSRC/device handoff without duplicate lane or transcript;
- authorized plus unauthorized simultaneous speech, with zero unauthorized
  subscription/usage;
- allowlist removal during capture and one lane failing while another succeeds;
- Input off aborting every active speaker lane;
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
2. Start console in thread A; verify the only canonical card is in that VC's
   built-in chat, the bound thread contains only its compact jump notice, and
   forwarded audio usage is zero.
3. Add threads B and C; verify no additional connection/STT client.
4. Stay muted for 60 seconds; forwarded duration remains zero.
5. Select A, unmute/speak/mute; only A receives one prompt.
6. Join from another client using the same Discord account if Discord permits
   that voice-state transition; verify any SSRC/device rebind remains the same
   author and does not duplicate a lane or transcript.
7. Have a second `DISCORD_ALLOWED_USER_IDS` member join muted. Let both allowed
   users speak with a brief overlap; verify separate transcripts/authors and
   binding-local order based on capture start.
8. Have a user absent from the allowlist speak; verify zero subscription,
   forwarded bytes, transcript, or segment for that user. Confirm they can hear
   output only according to ordinary Discord VC permissions.
9. Arm fan-out and select A+B; one utterance produces one STT final and one
   authenticated prompt in each target.
10. While A and B answer, verify distinct voices and no overlapping bot audio.
11. Generate long A output and short B output; verify fairness rotation only at
   chunk boundaries.
12. Disable A output mid-chunk; A stops promptly, B continues, A text remains.
13. Speak to B while its prior turn/playback is active; follow-up waits and then
    dispatches once.
14. Set Input off while one or more speakers are unmuted; verify every capture
    is discarded and no later commit occurs. Re-enable while still unmuted;
    verify each lane needs its own mute/unmute cycle.
15. Remove B and verify A/C remain live.
16. Stop console preserving pending text; verify connection/lease/card cleanup.
17. Inspect SQLite, dispatch artifacts, logs, and `DATA_DIR` for duplicate turns,
    raw audio, or leaked resources.

Abort immediately on unauthorized capture, mixed/misattributed speakers,
duplicate same-user lanes, unmute-only interruption, hidden routing, duplicate
fan-out dispatch, overlapping bot audio, stale-card mutation, raw-audio
persistence, or a leaked guild voice lease.

## 22. Definition of done

V2 is done when one admin can operate a durable, card-controlled, multi-thread
Voice Console in one Discord VC; every present Seam-allowed Discord identity can
speak through an independently attributed lane (including concurrent speakers
and same-identity device/SSRC transitions); the admin can explicitly focus or
fan out microphone input; everyone can hear serialized, distinguishable,
independently mutable thread responses; and the console can restart, remove,
cancel, or stop without unauthorized capture, duplicate turns, lost finalized
text, hidden routing state, raw-audio persistence, or regression of Live Help/V1
text behavior.
