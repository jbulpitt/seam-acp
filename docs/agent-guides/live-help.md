# Live help (Gemini in a Discord voice channel)

This is the canonical agent guide for voice-to-voice help. Deployment-specific
voice channels, consent overlays, and transcript policies belong in the private
`docs/local/` operator notes.

Consuming projects may pin this guide:

`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md`

Pin a tag or commit SHA when a course must not drift with `main`.

## Basic use

A coaching agent packs the current lesson, then asks Gemini to join a Discord
voice channel and speak with the participant. This is not TTS, voice-note
transcription, or Discord Go Live. The text ACP session remains in its thread.

1. Treat the current speaker's clear request as consent to start that speaker's
   session, subject to any policy in `docs/local/`.
2. Resolve `voiceChannelId` from the thread rider, then the channel rider. If
   neither provides one, consult `docs/local/`; do not guess a channel.
3. Call MCP `create_live_help` (no fence):

```json
{
  "voiceChannelId": "<voice-channel-id>",
  "system": "You are tutoring a student on fraction addition. Be brief. Do not give the answer first.",
  "historySummary": "The student understands unit fractions but needs practice finding a common denominator.",
  "notifyThread": "<optional-thread-id>"
}
```

Required: `voiceChannelId`, `system`. Optional: `historySummary`,
`notifyThread`, `preset`.

The tool returns `{ liveId }` immediately while the call continues in the
voice channel. Cancel it with `cancel_live_help({ liveId })`, or let the
idle, empty-channel, or provider duration limit end it.

## Who may start a call

- A course, coaching, or orchestration agent may start a call when an allowed
  speaker requests it.
- Participants may ask their course agent to start or stop their own session;
  do not turn a host refusal into a new approval rule.
- Resolve the designated channel from the rider or private operator notes. Do
  not ask the participant to invent a Discord snowflake.
- Use `create_live_help`, not a `seam-live` fence or an admin debug command.

If the tool refuses the request, report the actual host error, such as a busy
guild or invalid channel.

## Pack the live prompt

Keep `system` short: identify the participant generically, state the current
problem, say how hard to push, and name anything the tutor must not spoil.
`historySummary` should be a few sentences of relevant prior work, not a file
dump or URL library.

Do not include secrets, Discord tokens, or full private documents. Live video,
file search, URL context, and tool calls on the Live socket are not part of v1.

## Voice-channel behavior

- One Live call may occupy a voice channel at a time.
- Everyone undeafened in the channel is mixed into the call; v1 does not
  isolate a single speaker.
- Tell participants which designated channel to join and to unmute.
- Discord bots cannot receive Go Live screen share or webcam streams.

## During and after the call

The text session stays active in parallel. To change a tutor that has gone off
course, cancel the call and create a new one with a better `system` prompt.

`notifyThread` is opt-in. Set it only when the deployment's transcript policy
allows a short transcript in that thread. Calls do not save WAV or PCM files.
A missing notification thread must not terminate the call.

Authorized operators may also list or cancel calls through `/seam workflows`.
When a call ends, use any allowed short transcript or report to continue the
text lesson.

## What this is not

- inbound Discord voice-note transcription
- outbound TTS for a completed text turn
- Discord Go Live or webcam capture
- file search, URL context, or cached document retrieval
- multiplexing audio through the text ACP session

## Course onboarding

See `docs/agent-guides/live-help-onboarding.md`. A course overlay should add
only its designated voice channel, transcript policy, and tutoring constraints;
it should not fork the protocol.
