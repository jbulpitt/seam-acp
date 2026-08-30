import { FenceStream } from "../fence-stream.js";

export type SpeechTextKind = "prose" | "tool-output" | "directive";

export type StreamingSpeechSegmenterOptions = {
  minChars?: number;
  targetChars?: number;
  forceChars?: number;
};

const DEFAULT_MIN_CHARS = 80;
const DEFAULT_TARGET_CHARS = 320;
const DEFAULT_FORCE_CHARS = 400;

/**
 * Incrementally turns user-visible agent prose into TTS-sized chunks.
 *
 * Code/directive fences are consumed but never returned. Callers must also
 * identify non-prose agent events as `tool-output` or `directive`; those event
 * payloads are intentionally ignored rather than heuristically spoken.
 */
export class StreamingSpeechSegmenter {
  private readonly fences = new FenceStream();
  private readonly minChars: number;
  private readonly targetChars: number;
  private readonly forceChars: number;
  private prose = "";
  private firstChunkReleased = false;
  private finished = false;

  constructor(opts: StreamingSpeechSegmenterOptions = {}) {
    this.minChars = positiveInteger(opts.minChars, DEFAULT_MIN_CHARS);
    this.targetChars = Math.max(
      this.minChars,
      positiveInteger(opts.targetChars, DEFAULT_TARGET_CHARS)
    );
    this.forceChars = Math.max(
      this.targetChars + 1,
      positiveInteger(opts.forceChars, DEFAULT_FORCE_CHARS)
    );
  }

  /** Feed one arrival-ordered agent text event and return newly ready chunks. */
  feed(text: string, kind: SpeechTextKind = "prose"): string[] {
    if (this.finished) throw new Error("StreamingSpeechSegmenter is already flushed");
    if (!text || kind !== "prose") return [];

    for (const segment of this.fences.feed(text).segments) {
      if (segment.kind !== "prose") continue;
      this.prose += sanitizeMarkdownProse(segment.text);
    }
    return this.drain(false);
  }

  /** Flush the final speakable tail. An unfinished fence remains excluded. */
  flush(): string[] {
    if (this.finished) return [];
    this.finished = true;
    for (const segment of this.fences.flush().segments) {
      if (segment.kind !== "prose") continue;
      this.prose += sanitizeMarkdownProse(segment.text);
    }
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    while (true) {
      this.prose = this.prose.replace(/^\s+/, "");
      if (!this.prose) break;

      const paragraph = paragraphBoundary(this.prose);
      // Release exactly the first complete sentence immediately. Subsequent
      // chunks retain the established minimum so short sentences coalesce
      // instead of multiplying provider requests and fairness rotations.
      const sentence = this.firstChunkReleased
        ? firstSentenceBoundaryAtOrAfter(this.prose, this.minChars)
        : firstSentenceBoundary(this.prose);
      if (paragraph !== undefined && (sentence === undefined || paragraph.end <= sentence)) {
        const spoken = speechWhitespace(this.prose.slice(0, paragraph.start));
        this.prose = this.prose.slice(paragraph.end);
        if (spoken) {
          out.push(spoken);
          this.firstChunkReleased = true;
        }
        continue;
      }
      if (sentence !== undefined) {
        const spoken = speechWhitespace(this.prose.slice(0, sentence));
        this.prose = this.prose.slice(sentence);
        if (spoken) {
          out.push(spoken);
          this.firstChunkReleased = true;
        }
        continue;
      }

      if (this.prose.length >= this.forceChars) {
        const cut = safestForcedBoundary(this.prose, this.minChars, this.forceChars);
        const spoken = speechWhitespace(this.prose.slice(0, cut));
        this.prose = this.prose.slice(cut);
        if (spoken) {
          out.push(spoken);
          this.firstChunkReleased = true;
        }
        continue;
      }

      if (final) {
        const spoken = speechWhitespace(this.prose);
        this.prose = "";
        if (spoken) {
          out.push(spoken);
          this.firstChunkReleased = true;
        }
      }
      break;
    }
    return out;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function sanitizeMarkdownProse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+)/g, "$1")
    .replace(/(^|\n)[ \t]*(?:[-*_][ \t]*){3,}(?=\n|$)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/<\/?(?:seam|tool|function)[^>]*>/gi, "");
}

function speechWhitespace(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function paragraphBoundary(text: string): { start: number; end: number } | undefined {
  const match = /\n[ \t]*\n+/.exec(text);
  if (!match || match.index === 0) return match
    ? { start: match.index, end: match.index + match[0].length }
    : undefined;
  return { start: match.index, end: match.index + match[0].length };
}

function firstSentenceBoundary(text: string): number | undefined {
  const re = /[.!?](?:["')\]]*)\s+/g;
  const match = re.exec(text);
  return match ? match.index + match[0].trimEnd().length : undefined;
}

function firstSentenceBoundaryAtOrAfter(text: string, minimum: number): number | undefined {
  const re = /[.!?](?:["')\]]*)\s+/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const end = match.index + match[0].trimEnd().length;
    if (end >= minimum) return end;
  }
  return undefined;
}

function safestForcedBoundary(text: string, minimum: number, maximum: number): number {
  const window = text.slice(0, maximum);
  const candidates = [
    /[.!?](?:["')\]]*)\s+/g,
    /[,;:]\s+/g,
    /\s+/g,
  ];
  for (const re of candidates) {
    let best: number | undefined;
    for (let match = re.exec(window); match; match = re.exec(window)) {
      const end = match.index + match[0].trimEnd().length;
      if (end >= minimum) best = end;
    }
    if (best !== undefined) return best;
  }
  return maximum;
}
