import { codeFence, inlineCodeEnd, renderCode, textBlocks } from "./text-blocks.js";

/** This converter targets Chat's original syntax, not MARKUP_SYNTAX_MARKDOWN. */
export const GOOGLE_CHAT_TEXT_MARKUP_SYNTAX = "MARKUP_SYNTAX_CHAT" as const;

export function formatGoogleChatText(markdown: string): string {
  return textBlocks(markdown).map((block) => block.kind === "code"
    ? renderCode(block.body, codeFence(block.body, block.fence))
    : formatProse(block.text)).join("");
}

function formatProse(text: string): string {
  const code: string[] = [];
  let placeholder = "\u0000code";
  while (text.includes(placeholder)) placeholder += "_";
  let protectedText = "";
  for (let i = 0; i < text.length;) {
    const end = text[i] === "`" ? inlineCodeEnd(text, i) : undefined;
    if (end !== undefined) {
      protectedText += `${placeholder}${code.length}\u0000`;
      code.push(text.slice(i, end));
      i = end;
    } else { protectedText += text[i]!; i++; }
  }
  const lines = protectedText.split(/\r\n|\n|\r/);
  const output: string[] = [];
  const indents: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headers = tableCells(line);
    const delimiter = tableCells(lines[i + 1] ?? "");
    if (headers && delimiter?.length === headers.length && delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      i++;
      let count = 0;
      while (i + 1 < lines.length) {
        const cells = tableCells(lines[i + 1]!);
        if (!cells) break;
        i++;
        count++;
        output.push(`- ${cells.map((cell, column) =>
          `${formatInline(headers[column] || `Column ${column + 1}`)}: ${formatInline(cell)}`).join("; ")}`);
      }
      if (!count) output.push(headers.map(formatInline).join("; "));
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      output.push(boldHeading(heading[1]!));
      indents.length = 0;
      continue;
    }
    if (/^ {0,3}[^\s>*+\-]/.test(line) && /^ {0,3}(?:=+|-{3,})\s*$/.test(lines[i + 1] ?? "")) {
      output.push(boldHeading(line.trim()));
      i++;
      continue;
    }
    const list = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const indent = list[1]!.replace(/\t/g, "    ").length;
      while (indents.length && indent < indents[indents.length - 1]!) indents.pop();
      if (!indents.length || indent > indents[indents.length - 1]!) indents.push(indent);
      const marker = /^\d/.test(list[2]!) ? list[2]!.replace(/\)$/, ".") : "-";
      output.push(`${"    ".repeat(indents.length - 1)}${marker} ${formatInline(list[3]!)}`);
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) indents.length = 0;
    output.push(formatInline(line));
  }
  let result = output.join("\n");
  for (let i = 0; i < code.length; i++) result = result.replaceAll(`${placeholder}${i}\u0000`, code[i]!);
  return result;
}

function boldHeading(text: string): string {
  const formatted = formatInline(text);
  return formatted.startsWith("*") && formatted.endsWith("*") ? formatted : `*${formatted}*`;
}

function tableCells(line: string): string[] | undefined {
  if (!line.includes("|")) return undefined;
  const cells: string[] = [];
  let start = 0;
  let separated = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "`") {
      const end = inlineCodeEnd(line, i);
      if (end !== undefined) { i = end - 1; continue; }
    }
    if (line[i] === "|") { separated = true; cells.push(line.slice(start, i).trim()); start = i + 1; }
  }
  cells.push(line.slice(start).trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|") && !line.trimEnd().endsWith("\\|")) cells.pop();
  return separated && cells.length ? cells : undefined;
}

function formatInline(text: string): string {
  let result = "";
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === "\\" && i + 1 < text.length) {
      result += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "`") {
      const end = inlineCodeEnd(text, i);
      if (end !== undefined) { result += text.slice(i, end); i = end; continue; }
    }
    if (char === "<") {
      const token = /^<[^\n>]+>/.exec(text.slice(i))?.[0];
      if (token) {
        result += discordToken(token);
        i += token.length;
        continue;
      }
    }
    // Bare URLs are already links in Chat; underscores in them aren't emphasis.
    const url = /^(?:https?:\/\/|mailto:)[^\s<>]+/.exec(text.slice(i))?.[0];
    if (url) { result += url; i += url.length; continue; }
    const link = markdownLink(text, i);
    if (link) {
      result += `<${link.url}|${formatInline(link.label)}>`;
      i = link.end;
      continue;
    }
    const delimiter = /^(\*{1,3}|_{1,3}|~~|\|\|)/.exec(text.slice(i))?.[0];
    if (delimiter && canOpen(text, i, delimiter)) {
      const end = emphasisEnd(text, i + delimiter.length, delimiter);
      if (end !== undefined) {
        const body = formatInline(text.slice(i + delimiter.length, end));
        const target = delimiter === "||" ? undefined
          : delimiter === "~~" ? "~"
          : delimiter.length === 3 ? "*_"
          : delimiter.length === 2 ? "*" : "_";
        result += target ? `${target}${body}${target.split("").reverse().join("")}` : `[spoiler: ${body}]`;
        i = end + delimiter.length;
        continue;
      }
    }
    result += char;
    i++;
  }
  return result;
}

function canOpen(text: string, start: number, delimiter: string): boolean {
  const next = text[start + delimiter.length];
  if (!next || /\s/.test(next)) return false;
  return delimiter[0] !== "_" || !/[\p{L}\p{N}]/u.test(text[start - 1] ?? "");
}

function emphasisEnd(text: string, start: number, delimiter: string): number | undefined {
  const nested: number[] = [];
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      const end = inlineCodeEnd(text, i);
      if (end !== undefined) { i = end - 1; continue; }
    }
    if (delimiter[0] === "*" || delimiter[0] === "_") {
      if (text[i] !== delimiter[0]) continue;
      let length = 1;
      while (text[i + length] === delimiter[0]) length++;
      const closes = !/\s/.test(text[i - 1] ?? " ")
        && (delimiter[0] !== "_" || !/[\p{L}\p{N}]/u.test(text[i + length] ?? ""));
      let consumed = 0;
      if (closes) {
        while (nested.length && length - consumed >= nested[nested.length - 1]!) consumed += nested.pop()!;
        if (!nested.length && length - consumed >= delimiter.length) return i + consumed;
      }
      if (canOpen(text, i, delimiter[0]!.repeat(length)) && length !== delimiter.length) nested.push(length);
      i += length - 1;
      continue;
    }
    if (text.startsWith(delimiter, i) && !/\s/.test(text[i - 1] ?? " ")) return i;
  }
  return undefined;
}

function markdownLink(text: string, start: number): { label: string; url: string; end: number } | undefined {
  const labelStart = text.startsWith("![", start) ? start + 2 : text[start] === "[" ? start + 1 : undefined;
  if (labelStart === undefined) return undefined;
  let depth = 1;
  let labelEnd = labelStart;
  for (; labelEnd < text.length; labelEnd++) {
    if (text[labelEnd] === "\\") { labelEnd++; continue; }
    if (text[labelEnd] === "[") depth++;
    if (text[labelEnd] === "]" && --depth === 0) break;
  }
  if (text[labelEnd + 1] !== "(") return undefined;
  let end = labelEnd + 2;
  depth = 1;
  let quote = "";
  for (; end < text.length; end++) {
    const char = text[end]!;
    if (char === "\\") { end++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if ((char === '"' || char === "'") && /\s/.test(text[end - 1] ?? "")) { quote = char; continue; }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) break;
  }
  if (depth !== 0) return undefined;
  const destination = text.slice(labelEnd + 2, end).trim();
  const url = destination.startsWith("<")
    ? /^<([^>]+)>/.exec(destination)?.[1]
    : /^(\S+?)(?:\s+["'].*["'])?$/.exec(destination)?.[1];
  if (!url) return undefined;
  return { label: text.slice(labelStart, labelEnd), url: url.replace(/\\([()])/g, "$1"), end: end + 1 };
}

function discordToken(token: string): string {
  const mention = /^<(@!?|@&|#)(\d+)>$/.exec(token);
  if (mention) {
    const kind = mention[1] === "#" ? "#channel" : mention[1] === "@&" ? "@role" : "@user";
    return `${kind}:${mention[2]}`;
  }
  const emoji = /^<a?:([^:>]+):\d+>$/.exec(token);
  if (emoji) return `:${emoji[1]}:`;
  const timestamp = /^<t:(-?\d+)(?::[tTdDfFR])?>$/.exec(token);
  if (timestamp) {
    const date = new Date(Number(timestamp[1]) * 1000);
    return Number.isNaN(date.getTime()) ? `timestamp:${timestamp[1]}`
      : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
  }
  return token;
}
