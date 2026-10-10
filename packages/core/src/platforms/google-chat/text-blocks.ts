/** Code bodies exclude only the newline separating them from a closing fence. */
export type TextBlock = { kind: "text"; text: string } | { kind: "code"; body: string; fence: string };

export function textBlocks(text: string): TextBlock[] {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter((line) => line[0] !== "");
  const blocks: TextBlock[] = [];
  let proseStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const value = line[0].replace(/(?:\r\n|\n|\r)$/, "");
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (!opener || (opener[1]![0] === "`" && opener[2]!.includes("`"))) continue;
    const start = line.index!;
    if (start > proseStart) blocks.push({ kind: "text", text: text.slice(proseStart, start) });
    const delimiter = opener[1]!;
    const closer = new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closer.test(lines[end]![0].replace(/(?:\r\n|\n|\r)$/, ""))) end++;
    const bodyStart = start + line[0].length;
    const bodyEnd = end < lines.length ? lines[end]!.index! : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    blocks.push({
      kind: "code",
      body: end < lines.length ? body.replace(/(?:\r\n|\n|\r)$/, "") : body,
      fence: delimiter[0] === "`" ? delimiter : "```",
    });
    // Leave the closing line's newline in prose, preserving paragraph boundaries.
    proseStart = end < lines.length
      ? bodyEnd + lines[end]![0].replace(/(?:\r\n|\n|\r)$/, "").length
      : text.length;
    i = end;
  }
  if (proseStart < text.length) blocks.push({ kind: "text", text: text.slice(proseStart) });
  return blocks;
}

export function codeFence(body: string, minimum = "```"): string {
  const runs = [...body.matchAll(/`{3,}/g)].map((match) => match[0].length + 1);
  return "`".repeat(Math.max(minimum.length, ...runs));
}

export function renderCode(body: string, fence: string): string {
  return `${fence}\n${body}\n${fence}`;
}

export function inlineCodeEnd(text: string, start: number): number | undefined {
  const run = /^`+/.exec(text.slice(start))?.[0];
  if (!run) return undefined;
  let next = start + run.length;
  while ((next = text.indexOf(run, next)) !== -1) {
    if (text[next - 1] !== "`" && text[next + run.length] !== "`") return next + run.length;
    next += run.length;
  }
  return undefined;
}
