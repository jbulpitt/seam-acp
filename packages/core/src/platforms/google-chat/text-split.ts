import { inlineCodeEnd, renderCode, textBlocks } from "./text-blocks.js";
import { GOOGLE_CHAT_TEXT_MARKUP_SYNTAX } from "./text-format.js";

export const GOOGLE_CHAT_MESSAGE_MAX_BYTES = 32_000;

export interface GoogleChatTextSplitOptions {
  /** Total message budget, including JSON serialization. Defaults to Chat's 32,000 bytes. */
  maxBytes?: number;
  /** Bytes used by adapter-owned fields/cards beyond {text, markupSyntax}. */
  reservedBytes?: number;
}

export function googleChatTextPayloadBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ text, markupSyntax: GOOGLE_CHAT_TEXT_MARKUP_SYNTAX }), "utf8");
}

/** Split already-formatted text; closed/reopened code bodies concatenate without loss. */
export function splitGoogleChatText(text: string, options: GoogleChatTextSplitOptions = {}): string[] {
  const maxBytes = options.maxBytes ?? GOOGLE_CHAT_MESSAGE_MAX_BYTES;
  const reservedBytes = options.reservedBytes ?? 0;
  if (!Number.isInteger(maxBytes) || maxBytes > GOOGLE_CHAT_MESSAGE_MAX_BYTES || maxBytes <= 0
    || !Number.isInteger(reservedBytes) || reservedBytes < 0) {
    throw new RangeError("Chat message budget must be a positive integer at most 32000; reservedBytes must be non-negative.");
  }
  const fits = (value: string) => googleChatTextPayloadBytes(value) + reservedBytes <= maxBytes;
  const messages: string[] = [];
  let current = "";
  const flush = () => { if (current) messages.push(current); current = ""; };
  for (const block of textBlocks(text)) {
    if (block.kind === "code") {
      const complete = renderCode(block.body, block.fence);
      if (fits(current + complete)) { current += complete; continue; }
      flush();
      if (fits(complete)) { current = complete; continue; }
      let body = block.body;
      while (body) {
        const end = fittingPrefix(body, (part) => fits(renderCode(part, block.fence)));
        if (!end) throw new RangeError("Chat message budget cannot fit a fenced code character.");
        messages.push(renderCode(body.slice(0, end), block.fence));
        body = body.slice(end);
      }
      if (!block.body) throw new RangeError("Chat message budget cannot fit an empty code fence.");
      continue;
    }
    let prose = block.text;
    while (prose) {
      if (fits(current + prose)) { current += prose; break; }
      const end = fittingPrefix(prose, (part) => fits(current + part));
      if (!end) {
        if (current) { flush(); continue; }
        throw new RangeError("Chat message budget cannot fit a text character.");
      }
      const safeEnd = proseBoundary(prose, end);
      if (!safeEnd && current) { flush(); continue; }
      const cut = safeEnd || end;
      current += prose.slice(0, cut);
      prose = prose.slice(cut);
      flush();
    }
  }
  flush();
  return messages;
}

function fittingPrefix(text: string, fits: (part: string) => boolean): number {
  const ends: number[] = [0];
  for (const point of text) ends.push(ends[ends.length - 1]! + point.length);
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, ends[middle]))) low = middle;
    else high = middle - 1;
  }
  const end = ends[low]!;
  if (!end) return 0;
  const newline = text.lastIndexOf("\n", end - 1);
  return newline >= end / 2 ? newline + 1 : end;
}

function proseBoundary(text: string, end: number): number {
  let boundary = end;
  for (let i = 0; i < end; i++) {
    if (text[i] === "`") {
      const codeEnd = inlineCodeEnd(text, i);
      if (codeEnd !== undefined) {
        if (codeEnd > end) { boundary = i; break; }
        i = codeEnd - 1;
      }
    } else if (text[i] === "<") {
      const linkEnd = text.indexOf(">", i + 1);
      if (linkEnd !== -1) {
        if (linkEnd >= end) { boundary = i; break; }
        i = linkEnd;
      }
    }
  }
  const whitespace = text.slice(0, boundary).search(/\s+\S*$/);
  return whitespace > boundary / 2 ? whitespace + 1 : boundary;
}
