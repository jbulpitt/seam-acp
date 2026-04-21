import { describe, it, expect } from "vitest";
import { discordRenderer } from "../src/platforms/discord/renderer.js";

describe("discordRenderer", () => {
  it("status panel uses the right icon and rows", () => {
    const out = discordRenderer.statusPanel({
      state: "Working",
      repoDisplay: "myrepo",
      model: "gpt-5.4",
      action: "Starting…",
      elapsedSeconds: 3,
    });
    expect(out).toContain("⏳");
    expect(out).toContain("**Working**");
    expect(out).toContain("elapsed : 3s");
    expect(out).toContain("repo    : myrepo");
    expect(out).toContain("model   : gpt-5.4");
    expect(out).toContain("doing   : Starting…");
  });

  it("info box renders title, rows, and footer", () => {
    const out = discordRenderer.infoBox({
      title: "Hello",
      icon: "👋",
      rows: [
        { key: "a", value: "1" },
        { key: "longer", value: "2" },
      ],
      footer: "footer text",
    });
    expect(out.startsWith("👋 **Hello**")).toBe(true);
    expect(out).toContain("a      : 1");
    expect(out).toContain("longer : 2");
    expect(out.endsWith("footer text")).toBe(true);
  });

  it("trimShort truncates with ellipsis", () => {
    expect(discordRenderer.trimShort("abcdefgh", 5)).toBe("abcde…");
    expect(discordRenderer.trimShort("abc", 10)).toBe("abc");
  });

  it("codeBlock wraps with optional language", () => {
    expect(discordRenderer.codeBlock("x", "ts")).toBe("```ts\nx\n```");
    expect(discordRenderer.codeBlock("x")).toBe("```\nx\n```");
  });

  it("chunk delegates to chunkForDiscord", () => {
    expect(discordRenderer.chunk("hi")).toEqual(["hi"]);
  });
});
