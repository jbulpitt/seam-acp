import { inlineCodeEnd, textBlocks } from "./text-blocks.js";
import { formatGoogleChatText } from "./text-format.js";

/** Cards use HTML, not the original Chat syntax used by message text. */
export function formatGoogleChatCardText(markdown: string): string {
  return textBlocks(formatGoogleChatText(markdown)).map((block) => block.kind === "code"
    ? `<pre><code>${escapeHtml(block.body)}</code></pre>`
    : inlineHtml(block.text)).join("");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inlineHtml(text: string): string {
  let output = "";
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === "\\" && /[\\`*_~{}\[\]()#+\-.!|>]/.test(text[i + 1] ?? "")) {
      output += escapeHtml(text[i + 1]!);
      i += 2;
      continue;
    }
    if (char === "`") {
      const end = inlineCodeEnd(text, i);
      if (end !== undefined) {
        const delimiter = /^`+/.exec(text.slice(i))![0];
        output += `<code>${escapeHtml(text.slice(i + delimiter.length, end - delimiter.length))}</code>`;
        i = end;
        continue;
      }
    }
    if (char === "<") {
      const link = /^<([^\n>|]+)(?:\|([^\n>]*))?>/.exec(text.slice(i));
      if (link && /^(?:https?:\/\/|mailto:)/.test(link[1]!)) {
        output += `<a href="${escapeHtml(link[1]!)}">${inlineHtml(link[2] ?? link[1]!)}</a>`;
        i += link[0].length;
        continue;
      }
    }
    const url = /^(?:https?:\/\/|mailto:)[^\s<>]+/.exec(text.slice(i))?.[0];
    if (url) { output += escapeHtml(url); i += url.length; continue; }
    const tag = char === "*" ? "b" : char === "_" ? "i" : char === "~" ? "s" : undefined;
    if (tag && text[i + 1] !== char && text[i - 1] !== char && !/\s/.test(text[i + 1] ?? " ")
      && (char !== "_" || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
      const end = closingDelimiter(text, i + 1, char);
      if (end !== undefined) {
        output += `<${tag}>${inlineHtml(text.slice(i + 1, end))}</${tag}>`;
        i = end + 1;
        continue;
      }
    }
    if (char === "\r" || char === "\n") {
      output += "<br>";
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else { output += escapeHtml(char); i++; }
  }
  return output;
}

function closingDelimiter(text: string, start: number, delimiter: string): number | undefined {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      const end = inlineCodeEnd(text, i);
      if (end !== undefined) { i = end - 1; continue; }
    }
    if (text[i] === "<") {
      const link = /^<[^\n>]+>/.exec(text.slice(i))?.[0];
      if (link) { i += link.length - 1; continue; }
    }
    const url = /^(?:https?:\/\/|mailto:)[^\s<>]+/.exec(text.slice(i))?.[0];
    if (url) {
      if (url.endsWith(delimiter)) return i + url.length - 1;
      i += url.length - 1;
      continue;
    }
    if (text[i] === delimiter && !/\s/.test(text[i - 1] ?? " ")
      && (delimiter !== "_" || !/[\p{L}\p{N}]/u.test(text[i + 1] ?? ""))) return i;
  }
  return undefined;
}
