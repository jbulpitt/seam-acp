import { describe, it, expect } from "vitest";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";

describe("discordRenderer", () => {
  it("status panel uses the right icon and rows", () => {
    const out = discordRenderer.statusPanel({
      state: "Working",
      repoDisplay: "myrepo",
      model: "gpt-5.4",
      action: "Starting…",
      elapsedSeconds: 3,
    });
    expect(out.title).toBe("Working");
    expect(out.color).toBeDefined();
    
    // Check fields
    const repoField = out.fields?.find(f => f.name === "Repo");
    expect(repoField?.value).toBe("myrepo");
    
    const modelField = out.fields?.find(f => f.name === "Model");
    expect(modelField?.value).toBe("gpt-5.4");
    
    const actionField = out.fields?.find(f => f.name === "Action");
    expect(actionField?.value).toBe("Starting…");

    // Check footer
    expect(out.footer).toContain("⏱ 3s elapsed");
  });

  it("full card gains a brand author icon when brandFilename is set (#96)", () => {
    const out = discordRenderer.statusPanel({
      state: "Working",
      repoDisplay: "myrepo",
      model: "gpt-5.4",
      action: "Starting…",
      elapsedSeconds: 3,
      brandFilename: "copilot.png",
      authorName: "GitHub Copilot",
    });
    expect(out.title).toBe("Working");
    expect(out.author).toBe("GitHub Copilot");
    expect(out.authorIconURL).toBe("attachment://copilot.png");
    expect(out.fields.find((f) => f.name === "Repo")).toBeTruthy();
    expect(out.footer).toContain("🧠");
    expect(out.files).toBeUndefined();
  });

  it("simple card drops repo/model/action and uses compact footer (#96)", () => {
    const out = discordRenderer.statusPanel({
      state: "Working",
      repoDisplay: "myrepo",
      model: "gpt-5.4",
      action: "Tool: Read foo.ts",
      elapsedSeconds: 12,
      style: "simple",
      activity: ["Read foo.ts", "Edit bar.ts"],
      thinking: ["old thought", "latest plan"],
      context: "128k / 1m (13%)",
      contextPct: 13,
      brandFilename: "grok.webp",
    });
    expect(out.title).toBeUndefined();
    expect(out.author).toBe("Working");
    expect(out.authorIconURL).toBe("attachment://grok.webp");
    expect(out.fields).toEqual([]);
    expect(out.description).toBeUndefined();
    expect(out.footer).toMatch(/✏️/);
    expect(out.footer).toContain("💡 latest plan");
    expect(out.footer).toContain("⏱ 12s");
    expect(out.footer).toContain("🪟 13%");
    expect(out.footer).not.toContain("elapsed");
    expect(out.footer).not.toContain("effort");
    expect(out.footer).not.toContain("128k");
    expect(out.files).toBeUndefined();
  });

  it("simple dispatched card keeps the title prefix (#96)", () => {
    const out = discordRenderer.statusPanel({
      state: "Done",
      repoDisplay: "r",
      model: "m",
      action: "ok",
      elapsedSeconds: 1,
      style: "simple",
      titlePrefix: "📨 Handoff",
    });
    expect(out.title).toBe("📨 Handoff · Done");
    expect(out.author).toBe("Done");
    expect(out.authorIconURL).toBeUndefined();
  });

  it("simple card without a brand asset is text-only state (#96)", () => {
    const out = discordRenderer.statusPanel({
      state: "Failed",
      repoDisplay: "r",
      model: "m",
      action: "boom",
      elapsedSeconds: 4,
      style: "simple",
    });
    expect(out.author).toBe("Failed");
    expect(out.authorIconURL).toBeUndefined();
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
