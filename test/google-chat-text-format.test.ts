import { describe, expect, it } from "vitest";
import { formatGoogleChatText, GOOGLE_CHAT_TEXT_MARKUP_SYNTAX } from "../packages/core/src/platforms/google-chat/text-format.js";

describe("Google Chat original-syntax formatter", () => {
  it("names the mode the adapter must select", () => {
    expect(GOOGLE_CHAT_TEXT_MARKUP_SYNTAX).toBe("MARKUP_SYNTAX_CHAT");
  });

  it("converts the existing speech-segmenter agent-prose sample", () => {
    // Sample from streaming-speech-segmenter.test.ts, not a live-provider capture.
    const input = "## Result\n- Read **the [guide](https://example.com/docs)** and use `seam config tts`.\n---\n";
    expect(formatGoogleChatText(input)).toBe("*Result*\n- Read *the <https://example.com/docs|guide>* and use `seam config tts`.\n---\n");
  });

  it.each([
    ["**bold** and __bold__", "*bold* and *bold*"],
    ["*italic* and _italic_", "_italic_ and _italic_"],
    ["~~removed~~", "~removed~"],
    ["***both*** and ___both___", "*_both_* and *_both_*"],
    ["**bold *italic* tail**", "*bold _italic_ tail*"],
    ["*italic **bold** tail*", "_italic *bold* tail_"],
    ["**bold *italic***", "*bold _italic_*"],
    ["*italic **bold***", "_italic *bold*_"],
    ["file_name and foo_bar_baz", "file_name and foo_bar_baz"],
    ["unclosed **bold", "unclosed **bold"],
    ["\\*literal\\*", "\\*literal\\*"],
  ])("formats %s", (input, expected) => {
    expect(formatGoogleChatText(input)).toBe(expected);
  });

  it("turns headings into bold without double wrapping existing bold", () => {
    expect(formatGoogleChatText("# One\n## **Two**\n###### Six ###\nTitle\n===")).toBe("*One*\n*Two*\n*Six*\n*Title*");
  });

  it("uses four spaces per nesting level, preserving literal numbered lists", () => {
    const input = "- parent\n  + child\n    * grandchild\n- sibling\n1. first\n2) second\n    - child";
    expect(formatGoogleChatText(input)).toBe("- parent\n    - child\n        - grandchild\n- sibling\n1. first\n2. second\n    - child");
    expect(formatGoogleChatText("- root\n    - child\n        - grandchild")).toBe("- root\n    - child\n        - grandchild");
  });

  it("retains native blockquotes and formats their prose", () => {
    expect(formatGoogleChatText("> **Warning**\n> use `a_b * c`\n>> nested")).toBe("> *Warning*\n> use `a_b * c`\n>> nested");
  });

  it("handles balanced URL parentheses, titles, images, and escaped labels", () => {
    const input = '[x](https://en.wikipedia.org/wiki/Function_(mathematics)) [docs](https://example.com "a title") ![graph](https://example.com/a.png) [a\\]b](https://example.com)';
    expect(formatGoogleChatText(input)).toBe('<https://en.wikipedia.org/wiki/Function_(mathematics)|x> <https://example.com|docs> <https://example.com/a.png|graph> <https://example.com|a\\]b>');
  });

  it("keeps bare and native links intact, without interpreting URL underscores", () => {
    const input = "https://example.com/a_b_c <https://example.com|label> <https://example.com>";
    expect(formatGoogleChatText(input)).toBe(input);
  });

  it("keeps inline code exact, including multiline content and Discord markup", () => {
    const code = "`` **literal** * _ ~~ <@123> [x](url) ` \r\n# not a heading ``";
    expect(formatGoogleChatText(`**Outside** ${code}`)).toBe(`*Outside* ${code}`);
    expect(formatGoogleChatText("**before `**literal**` after**")).toBe("*before `**literal**` after*");
  });

  it("preserves fenced contents exactly, removing only the language hint", () => {
    const body = "const a = '*_';\r\n\t// **bold** <@123> ||secret||\r\n  trailing spaces  \r\n";
    expect(formatGoogleChatText(`before\n\`\`\`ts\r\n${body}\r\n\`\`\`\r\nafter`)).toBe(`before\n\`\`\`\n${body}\n\`\`\`\nafter`);
  });

  it("uses the existing fence-stream prose/code/prose sample", () => {
    expect(formatGoogleChatText("a\n```js\nx\n```\nb\n```py\ny\n```\nc")).toBe("a\n```\nx\n```\nb\n```\ny\n```\nc");
  });

  it("closes an unfinished fence without formatting its contents", () => {
    expect(formatGoogleChatText("```ts\n**literal** _x_\n")).toBe("```\n**literal** _x_\n\n```");
  });

  it("preserves nested literal fence contents rather than editing code", () => {
    expect(formatGoogleChatText("````markdown\n```ts\n* x\n```\n````")).toBe("````\n```ts\n* x\n```\n````");
    expect(formatGoogleChatText("~~~js\nconst x = '*_';\n~~~")).toBe("```\nconst x = '*_';\n```");
  });

  it("turns the output-pipeline golden table into readable labelled rows", () => {
    // Existing golden output corpus, not a captured provider transcript.
    const table = "| Name  | Role   |\n| ----- | ------ |\n| Alice | Eng    |\n| Bob   | PM     |\n| Carol | Design |\n| Dave  | Sales  |";
    expect(formatGoogleChatText(table)).toBe("- Name: Alice; Role: Eng\n- Name: Bob; Role: PM\n- Name: Carol; Role: Design\n- Name: Dave; Role: Sales");
  });

  it("retains escaped and code pipes in table cells, including extra columns", () => {
    const table = "| Item | Value |\n| :--- | ---: |\n| a\\|b | `x|y **` | extra |";
    expect(formatGoogleChatText(table)).toBe("- Item: a\\|b; Value: `x|y **`; Column 3: extra");
  });

  it("does not rewrite non-tables or discard empty table headers", () => {
    expect(formatGoogleChatText("a | b\nnot a separator")).toBe("a | b\nnot a separator");
    expect(formatGoogleChatText("| A | B |\n| --- | --- |")).toBe("A; B");
    expect(formatGoogleChatText("| A |\n| --- |\n| one |")).toBe("- A: one");
    expect(formatGoogleChatText("| | B |\n| --- | --- |\n| one | two |")).toBe("- Column 1: one; B: two");
  });

  it("renders Discord identities as readable labels, never Google mentions", () => {
    expect(formatGoogleChatText("<#123> <@456> <@!789> <@&321> <:done:654> <a:spin:987>")).toBe("#channel:123 @user:456 @user:789 @role:321 :done: :spin:");
  });

  it("renders Discord timestamps deterministically in UTC, including relative ones", () => {
    expect(formatGoogleChatText("<t:0:R> <t:1:F> <t:-1>")).toBe("1970-01-01 00:00:00 UTC 1970-01-01 00:00:01 UTC 1969-12-31 23:59:59 UTC");
  });

  it("labels spoilers explicitly without pretending they remain hidden", () => {
    expect(formatGoogleChatText("||**answer** <@123>||")).toBe("[spoiler: *answer* @user:123]");
  });

  it("handles an actual redacted worker handoff, not a synthetic native trace", () => {
    // Agent-authored handoff from the Google Chat history groundwork; deployment names redacted.
    const input = "Draft [PR #940](https://github.com/jbulpitt/seam-acp/pull/940), head `97da9392`. Standalone reader, fake-API tests and guide; no adapter wiring.\n\nExact admin setup:\n\n1. In project **PROJECT**, open **APIs & Services → Enabled APIs & services**.";
    expect(formatGoogleChatText(input)).toBe("Draft <https://github.com/jbulpitt/seam-acp/pull/940|PR #940>, head `97da9392`. Standalone reader, fake-API tests and guide; no adapter wiring.\n\nExact admin setup:\n\n1. In project *PROJECT*, open *APIs & Services → Enabled APIs & services*.");
  });
});
