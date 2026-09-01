# Live help (Gemini in a Discord voice channel)

Canonical **agent** how-to. The Discord preamble and MCP blurbs stay one-liners;
**this file is the spec**. Do not wait for the harness to teach you.

Consuming projects (especially school / coaching threads) pin this raw URL:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md`

Pin to a tag or commit SHA if a class must not drift with `main`. Overlay only
**this course** (which voice channel Jesse approved, notify thread, consent).
Do not fork the protocol.

v1 is specified in GitHub **#98**. Spike (join / capture / Live round-trip) is
proven. **MCP `create_live_help` / `cancel_live_help` are the product.** If they
are **not** in your tool list yet (old process), do not invent a fence and do
not run `/seam debug voice-*` — wait, or ask Jesse.

---

## The basic use (do this first)

You are a **coaching agent** in a text thread. You pack the lesson, then ask
Gemini to **join a voice channel** and talk with the student live.

This is **not** TTS of your last reply and **not** transcribing a voice note.
Gemini Live hears speech in the VC and talks back. It replies after a short pause in speech; talking over it barges in.
Your text ACP session **stays in this thread** (parallel session — do not try
to pipe PCM through `rt.prompt`).

1. Treat the current speaker's clear request for live help as consent. Students
   do **not** need separate parent/admin approval to start their own session.
2. Resolve `voiceChannelId` in this order — then tell the student (or Jesse)
   which VC to join:
   1. **This thread’s rider** (thread overlay, else the channel rider). Look
      for a designated live-help / voice-channel **snowflake** for the current
      thread. That wins.
   2. Else the fallback: family-guild **General** `1487095870188027987`.
3. Mint with MCP `create_live_help` (no fence):

```json
{
  "voiceChannelId": "1487095870188027987",
  "system": "You are tutoring Alaina on fraction addition. Be brief. Do not give the answer first. Stay on this problem.",
  "historySummary": "She missed 1/2 + 1/4 yesterday. She understands unit fractions.",
  "notifyThread": "<this thread's snowflake if you want a live transcript here>"
}
```

Required: `voiceChannelId`, `system`.  
Optional: `historySummary`, `notifyThread`, `preset`.

You get `{ liveId }` back. You do **not** block. The call runs in the VC.

4. Stay in the text thread. You can keep coaching in text, or wait for hangup
   and a short transcript if you set `notifyThread`.
5. Hang up with `cancel_live_help({ liveId })` when the lesson is done, or let
   idle / empty-VC / Google’s ~15 min window end it.

That is enough for a lesson.

---

## Who may mint

- **You** (the course / coaching agent, or the orchestrator) may mint when an
  allowed speaker asks for live help, including Alaina or Allie in their own
  course threads. Live help is a self-service learning feature, not config.
- Students may ask you to start or stop their session. Resolve the voice
  channel from the thread/channel rider, then the documented fallback; do not
  make them supply or choose an arbitrary snowflake.
- **Not** a `seam-live` fence. Same reason as `create_ingest`: a fence taxes
  the coaching turn and is the wrong object.
- `/seam debug voice-ping|voice-capture|voice-live` is **admin spike** in
  pairing, not how you start a lesson.

If `create_live_help` is refused, report the actual host error (for example a
busy guild or invalid channel). Do not turn it into a parent-approval request.

---

## What to pack in `system` / `historySummary`

`system` is the live tutor’s job: who the student is, the problem, how hard to
push, what not to spoil. Keep it short. This model is voice-first and brief.

`historySummary` is a few sentences of prior work — **not** a file dump, not
File Search, not a URL library (Live does not have those).

Do **not** put secrets, Discord tokens, or whole worksheets as text. A
worksheet photo as Live video frames is **not v1**.

---

## Voice channel

Pass an explicit snowflake from the rider (or the fallback below). Do not
guess from a text channel name.

- **This thread first:** if the rider names a live-help / voice-channel
  snowflake for **this thread**, use that. Thread rider beats channel rider.
- **Fallback** if the rider is silent: family-guild General
  `1487095870188027987`.
- One Live call per VC. If the bot is already in that channel, cancel first
  or pick another VC.
- Everyone undeafened in that VC is mixed in (v1 does not isolate one user).

Tell the humans: unmute, join **that** VC, talk. You cannot pull Discord
screen share or webcam (bots do not get Go Live). Do not promise it.

---

## During the call

- Gemini hears whoever is speaking in the VC and talks back there.
- Your text thread is still you. Do not try to “steer” Live PCM with a normal
  prompt unless the host has a documented cancel/re-mint path — v1 hangup is
  `cancel_live_help` and remint with a better `system` if the tutor went off
  the rails.
- `notifyThread` **opt-in**. Omit it if you do not want a transcript in
  Discord. Set it to this course thread or a staff thread so Jesse can read
  later. A missing notify thread must not kill the call.
- No wav/pcm on disk. Do not ask to “save the recording.”

---

## Hangup

- `cancel_live_help({ liveId })`
- `/seam workflows` can list/cancel (Jesse / admin)
- Empty VC idle, max duration, or Live `GoAway` — v1 does **not** resume

When it ends you may get a short transcript in `notifyThread` and/or a
report-back in the minting thread. Use that to continue the **text** lesson.

---

## Self-service and consent

A clear request from the current student/speaker is consent to start that
speaker's live-help session. Allie and Alaina may initiate and end their own
sessions through their course agent; no separate Jesse/admin confirmation is
required. Do not auto-join a VC when nobody requested live help.

---

## What this is not

- Inbound Discord STT (voice notes on a message)
- Outbound TTS of a finished text turn (`/seam config tts`)
- Discord Go Live / screen share / student webcam
- JPEG stills into Live (`realtimeInput.video`) — follow-on; 3.1 bills every
  frame
- File Search, URL context, caching, Vertex Live
- Live tools (`lookup`, `submit_result`, `handoff` on the Live socket) — not v1
- Multiplexing the call through this text session

---

## Pin this in a school / course repo

See `docs/agent-guides/live-help-onboarding.md` (paste-1 for a new overlay).
A brand-new school session should know: pack the lesson, `create_live_help`
with the designated VC snowflake (rider first, else General), students join that VC,
and students may request or end their own session without parent approval.
