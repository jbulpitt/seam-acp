# Live help — onboarding prompt (school / coaching projects)

Paste **1** into a course or school-agent repo that does **not** yet know
Gemini-in-a-voice-channel. That agent should fetch the canonical guide, hang
the raw URL in its own library, and overlay only that course (approved VC
snowflake, consent).

Canonical spec (do not fork):
`https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md`

This is the **school / coaching** version. Pairing/debug (`/seam debug voice-*`)
is not for these agents. Updated 2026-08-23 for production issue **#98**.

MCP `create_live_help` ships with #98. If the tool is missing, persist the
guide anyway and wait — do not invent a fence.

---

**1. Persist into that project’s context library** (use this)

```
Seam-acp live help is a KEY SKILL for this course: you pack a lesson in THIS text thread, then Gemini joins a Discord voice channel and tutors by voice. Persist this into the project context library (AGENTS.md, rider, docs/agent-context, CLAUDE.md, etc.) so NEW sessions see it without this message.

Fetch and keep this guide (re-read it now):
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md

Link that URL in the library. Overlay only THIS course (which voice channel Jesse approved, whether to set notifyThread, when to ask consent). Do not fork the protocol.

Persist these facts:

DEFAULT USE
- Live help is NOT TTS of your last text reply and NOT transcribing a Discord voice note. Gemini hears and speaks in a voice channel. Your text session stays here (parallel).
- Mint with MCP create_live_help only. No seam-live fence. Required: voiceChannelId (snowflake), system (short tutor job). Optional: historySummary (a few sentences, not files), notifyThread (opt-in transcript), preset.
- Returns { liveId }. You do not block. Hang up with cancel_live_help({ liveId }).
- Students (Alaina/Allie) may BE in the call. They are participants — they must not mint, cancel, or pick the channel. If create_live_help is refused, stop.
- Voice channel is an explicit snowflake Jesse approved. Family-guild General is 1487095870188027987. Never pass a school-* voice channel or guess from this text channel's name. Ask Jesse if unsure. Consent is Jesse's policy — default is do not start a voice session unprompted; use a frozen click-card to ask him.
- Do not promise Discord screen share, webcam, or Go Live. Bots cannot receive those. Do not use /seam debug voice-*.
- notifyThread omitted = no transcript posts. Set it to this thread or a staff thread if Jesse should read later.

After writing the library entry, confirm: file path(s), the raw guide URL is in them, and a brand-new session would pack a lesson and mint live help instead of faking it with TTS.
```

**2. Short nudge** if they only know STT/TTS:

```
Update the course library from
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md
Voice notes and /seam config tts stay the message path. Live help is Gemini joining a VC (create_live_help). Kids may listen; they must not mint. No school-* VCs. No screen share. Say which file you changed.
```

**3. Refresh snippet** after #98 merges (tools actually present):

```
Re-fetch and keep:
https://raw.githubusercontent.com/jbulpitt/seam-acp/main/docs/agent-guides/live-help.md
create_live_help / cancel_live_help should now be in your MCP list. Overlay still THIS course's approved voiceChannelId. If the tool is still missing, say so — do not work around it.
Say which file(s) you changed.
```
