import { describe, expect, it } from "vitest";
import { formatGoogleChatText } from "../packages/core/src/platforms/google-chat/text-format.js";
import { textBlocks } from "../packages/core/src/platforms/google-chat/text-blocks.js";
import { GOOGLE_CHAT_MESSAGE_MAX_BYTES, googleChatTextPayloadBytes, splitGoogleChatText } from "../packages/core/src/platforms/google-chat/text-split.js";

describe("Google Chat byte-budgeted text splitting", () => {
  it("has the documented 32000-byte message limit", () => {
    expect(GOOGLE_CHAT_MESSAGE_MAX_BYTES).toBe(32_000);
    expect(splitGoogleChatText("")).toEqual([]);
    expect(splitGoogleChatText("hello")).toEqual(["hello"]);
  });

  it("accounts for the serialized text and original-markup mode", () => {
    const text = 'quotes " and backslash \\ and newline\n🙂';
    expect(googleChatTextPayloadBytes(text)).toBe(Buffer.byteLength(JSON.stringify({ text, markupSyntax: "MARKUP_SYNTAX_CHAT" })));
    const exact = googleChatTextPayloadBytes(text);
    expect(splitGoogleChatText(text, { maxBytes: exact })).toEqual([text]);
    expect(splitGoogleChatText(`${text}x`, { maxBytes: exact }).length).toBeGreaterThan(1);
  });

  it("preserves all Unicode and whitespace across messages", () => {
    const text = "🙂漢字é\n  trailing spaces  \n\n".repeat(2200);
    const messages = splitGoogleChatText(text);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.join("")).toBe(text);
    for (const message of messages) {
      expect(googleChatTextPayloadBytes(message)).toBeLessThanOrEqual(32_000);
      expect(message).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(message).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });

  it("reserves adapter-owned fields/cards without silently choosing a character limit", () => {
    const messages = splitGoogleChatText("x".repeat(64_000), { reservedBytes: 1000 });
    expect(messages.join("")).toBe("x".repeat(64_000));
    expect(messages.every((message) => googleChatTextPayloadBytes(message) + 1000 <= 32_000)).toBe(true);
  });

  it("keeps a small fenced block intact, moving it to the next message when needed", () => {
    const fence = "```\n**literal** _x_\n```";
    const text = `before ${"x".repeat(90)}\n${fence}\nafter`;
    const messages = splitGoogleChatText(text, { maxBytes: 160 });
    expect(messages.join("")).toBe(text);
    expect(messages.some((message) => message.includes(fence))).toBe(true);
    expect(messages.every((message) => googleChatTextPayloadBytes(message) <= 160)).toBe(true);
  });

  it("closes/reopens long fenced blocks, preserving each code byte including CRLF", () => {
    const body = "  *_🙂\\\"\r\n\t<tag>  \r\n".repeat(4000);
    const text = formatGoogleChatText(`\`\`\`ts\n${body}\n\`\`\``);
    const messages = splitGoogleChatText(text);
    expect(messages.length).toBeGreaterThan(1);
    const recovered: string[] = [];
    for (const message of messages) {
      expect(googleChatTextPayloadBytes(message)).toBeLessThanOrEqual(32_000);
      expect(message.startsWith("```\n")).toBe(true);
      expect(message.endsWith("\n```")).toBe(true);
      const blocks = textBlocks(message);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("code");
      if (blocks[0]!.kind === "code") recovered.push(blocks[0]!.body);
    }
    expect(recovered.join("")).toBe(body);
  });

  it("splits an oversized single code line only at Unicode boundaries", () => {
    const body = "🙂*_".repeat(9000);
    const messages = splitGoogleChatText(`\`\`\`\n${body}\n\`\`\``);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.map((message) => message.slice(4, -4)).join("")).toBe(body);
    expect(messages.every((message) => googleChatTextPayloadBytes(message) <= 32_000)).toBe(true);
  });

  it("preserves prose/code ordering across multiple split blocks", () => {
    const body = "x\n".repeat(100);
    const messages = splitGoogleChatText(`intro\n\`\`\`\n${body}\n\`\`\`\noutro\n\`\`\`\ny\n\`\`\``, { maxBytes: 150 });
    const code = messages.flatMap(textBlocks).filter((block) => block.kind === "code");
    expect(code.map((block) => block.body).join("")).toBe(`${body}y`);
    expect(messages[0]).toBe("intro\n");
    expect(messages.join("")).toContain("outro\n```\ny\n```");
    expect(messages.every((message) => googleChatTextPayloadBytes(message) <= 150)).toBe(true);
  });

  it("keeps fitting inline code and links together at a message boundary", () => {
    const code = "`**code** a_b`";
    const link = "<https://example.com/a_b|label>";
    const text = `${"x".repeat(40)} ${code} ${link} tail`;
    const messages = splitGoogleChatText(text, { maxBytes: 100 });
    expect(messages.join("")).toBe(text);
    expect(messages.some((message) => message.includes(code))).toBe(true);
    expect(messages.some((message) => message.includes(link))).toBe(true);
  });

  it("retains a longer fence when the code itself includes triple backticks", () => {
    const body = "```\n*_\n```\n".repeat(20);
    const messages = splitGoogleChatText(`\`\`\`\`\n${body}\n\`\`\`\``, { maxBytes: 150 });
    expect(messages.map((message) => message.slice(5, -5)).join("")).toBe(body);
    expect(messages.every((message) => message.startsWith("````\n") && message.endsWith("\n````"))).toBe(true);
  });

  it("reports a budget that cannot fit content instead of dropping it or looping", () => {
    expect(() => splitGoogleChatText("x", { maxBytes: 1 })).toThrow(/cannot fit a text character/);
    expect(() => splitGoogleChatText("\n", { maxBytes: 1 })).toThrow(/cannot fit a text character/);
    expect(() => splitGoogleChatText("```\nx\n```", { maxBytes: googleChatTextPayloadBytes("x") })).toThrow(/cannot fit a fenced code character/);
    expect(() => splitGoogleChatText("x", { maxBytes: 32_001 })).toThrow(/at most 32000/);
    expect(() => splitGoogleChatText("x", { reservedBytes: -1 })).toThrow(/reservedBytes/);
  });
});
