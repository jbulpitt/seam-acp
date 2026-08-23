# Live help (Gemini in a Discord voice channel)

Design + spike only. **Not production.** STT/TTS stay on the message path;
this is a new **voice-channel** path.

Canonical for agents: pin this file’s raw GitHub URL if a course needs it.
Do not treat this as shipped MCP.

---

## What it is

A learning-coach (or this orchestrator) packs **text context**, then Gemini
**joins a Discord voice channel** and talks with a student in real time.

It is not “read the last TTS clip.” Gemini Live is native audio↔audio:
it hears speech (optional JPEG ≤1 fps, plus text) and talks back. Barge-in
is Gemini’s VAD.

**Studio only.** `gemini-3.1-flash-live-preview` over
`BidiGenerateContent`. Vertex does **not** support Live 3.x (only
`gemini-live-2.5-flash-native-audio`). Same `SEAM_GEMINI_API_KEY` as STT/TTS.

## What it is not

- Not inbound Discord STT (already shipped).
- Not outbound TTS of a finished turn (already shipped).
- Not File Search / URL context / caching (Live does not have them).
- Not a school-channel default. Consent is a **human policy**, not a flag.

---

## Production shape (after the spike)

MCP `create_live_help` (mint-only, **no fence** — same reason as
`create_ingest`: a fence would tax the coaching agent).

Args:

- `voiceChannelId` (snowflake) — required
- `system` — packed lesson / student / problem (required)
- `historySummary` — optional short text, **not** a file library
- `notifyThread` — optional Discord thread for a live transcript
- `preset` — optional; resolved at fire like ingest

Host:

1. `@discordjs/voice` join that channel (needs `GuildVoiceStates` intent;
   **not in the tree today**).
2. Open Live WS:
   `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`
3. First message: `setup` with `model: models/gemini-3.1-flash-live-preview`,
   `responseModalities: ["AUDIO"]`, `systemInstruction`, optional
   `generationConfig.speechConfig.voiceConfig`.
4. Packed history as `clientContent` turns (`initial_history_in_client_content`
   style), not File Search.
5. Bridge: Discord Opus → PCM **16 kHz** s16le up (`audio/pcm;rate=16000`);
   Gemini PCM **24 kHz** down → Opus into the VC.
6. Optional `inputTranscription` / `outputTranscription` → `notifyThread`.
   Do **not** persist raw audio.
7. Tools on the Live session are **ours** (`lookup`, maybe `submit_result`,
   `handoff`) via Live `toolCall` / `toolResponse`. Thin. No repo dump.

Limits (Google):

- ~15 min of audio unless sliding-window compression
- ~10 min WS unless `sessionResumption` handle; `GoAway` → rejoin with handle
- Context ~128k in / 64k out on 3.1 Live
- Function calling and Search grounding: yes. Batch/caching: no.

School:

- Allie/Alaina are **participants**, not config admins. They may be *in* the
  call; they must not mint `create_live_help`.
- Default: no wav on disk. Optional transcript into `notifyThread` so Jesse
  can read later.
- Never spike in `#school-*` voice until the ping+join loop is proven on a
  test channel.

## Why a new session type

The text ACP session stays on the thread. Live is a **parallel** session:
different wire, different model, different lifetime. When it ends, the
text agent can be handed a short transcript. Do not multiplex Live PCM
through `rt.prompt`.

---

## Spike checklist (stop after these)

Do **not** add MCP, school channels, resume, or Live tools until this works.

1. Enable `GuildVoiceStates`. Add `@discordjs/voice` + opus/sodium. Join a
   **test** VC, play a local ogg, leave.
2. Capture one user’s Opus → 16 kHz PCM file (then delete; spike only).
3. 30s Gemini Live ping with the Studio key: `setup` + one text or PCM clip
   → receive 24 kHz audio back. No Discord.
4. Round-trip: captured Discord PCM → Live → play in the test VC.
5. **Stop.**

---

## Open questions (human)

- Which test voice channel (snowflake)? Never a school VC for the spike.
- After spike: one-shot sessions vs resumable classroom block.
- Transcript in `notifyThread`: on by default or opt-in?
