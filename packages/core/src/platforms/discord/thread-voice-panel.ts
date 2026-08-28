const DISCORD_CONTENT_MAX = 2_000;

/** Split a visible finalized transcript into Discord-safe echo messages. */
export function threadVoiceTranscriptMessages(
  ownerName: string,
  transcript: string
): string[] {
  const text = transcript.trim();
  if (!text) return [];
  const out: string[] = [];
  let rest = text;
  let first = true;
  while (rest) {
    const prefix = first ? `🎙️ ${ownerName}: ` : `🎙️ ${ownerName} (continued): `;
    const room = DISCORD_CONTENT_MAX - prefix.length;
    let take = Math.min(room, rest.length);
    if (take < rest.length) {
      const candidate = rest.slice(0, take);
      const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
      if (boundary >= Math.floor(room * 0.6)) take = boundary;
    }
    const chunk = rest.slice(0, take).trim();
    if (chunk) out.push(prefix + chunk);
    rest = rest.slice(take).trimStart();
    first = false;
  }
  return out;
}
