/**
 * Conservative, deterministic reconstruction transforms.
 *
 * Inspired by techniques catalogued by Claw Compactor
 * (https://github.com/open-compress/claw-compactor, MIT), but this is a
 * native TypeScript allowlist — not that project's summarizer/rewind pipeline.
 */

const DATA_URL = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]{200,}/gi;
const BARE_BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{240,}={0,2}(?![A-Za-z0-9+/=])/g;
const ABS_PATH = /(?:^|[\s"'`=(])(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g;

export interface NormalizeResult {
  text: string;
  savedChars: number;
}

export function normalizeReconstructionMessage(
  text: string,
  opts: { priorExactTexts?: ReadonlySet<string> } = {}
): NormalizeResult {
  const original = text;
  let next = replaceExactDuplicate(text, opts.priorExactTexts);
  next = normalizeWhitespaceOutsideFences(next);
  next = replaceLargeBase64(next);
  next = substituteRepeatedPathPrefixes(next);
  return { text: next, savedChars: Math.max(0, original.length - next.length) };
}

function replaceExactDuplicate(text: string, prior?: ReadonlySet<string>): string {
  if (!prior || prior.size === 0) return text;
  if (!prior.has(text)) return text;
  return `[exact duplicate of an earlier message in this reconstruction]`;
}

function normalizeWhitespaceOutsideFences(text: string): string {
  const parts = splitByFences(text);
  return parts
    .map((part) => {
      if (part.fence) return part.text;
      return part.text
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
    })
    .join("");
}

function replaceLargeBase64(text: string): string {
  let out = text.replace(DATA_URL, (_all, mime: string) => {
    return `[omitted ${mime} attachment; original bytes were inline base64]`;
  });
  out = out.replace(BARE_BASE64, (blob) => {
    if (blob.length < 240) return blob;
    return `[omitted base64 payload (${blob.length} chars)]`;
  });
  return out;
}

function substituteRepeatedPathPrefixes(text: string): string {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(ABS_PATH)) {
    const path = match[1];
    if (!path) continue;
    const prefix = directoryPrefix(path);
    if (!prefix) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const prefixes = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([prefix]) => prefix)
    .sort((a, b) => b.length - a.length);
  if (prefixes.length === 0) return text;
  const chosen = prefixes[0]!;
  const alias = "$P0";
  if (text.includes(`${alias} = `)) return text;
  const replaced = text.split(chosen).join(`${alias}/`);
  return `Path aliases used in this message:\n- ${alias} = ${chosen.replace(/\/$/, "")}\n\n${replaced}`;
}

function directoryPrefix(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  return `/${parts.slice(0, Math.min(parts.length - 1, 4)).join("/")}/`;
}

function splitByFences(text: string): Array<{ text: string; fence: boolean }> {
  const parts: Array<{ text: string; fence: boolean }> = [];
  const re = /```[\s\S]*?```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), fence: false });
    parts.push({ text: match[0], fence: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), fence: false });
  return parts;
}
