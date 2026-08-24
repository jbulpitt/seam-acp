import { describe, it, expect } from "vitest";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";

describe("TurnStatus style + brand (#96)", () => {
  it("defaults to full and omits style from toInput", () => {
    const s = new TurnStatus({ model: "m", repoDisplay: "r" });
    expect(s.style).toBe("full");
    expect(s.toInput().style).toBeUndefined();
  });

  it("threads simple style, brand filename, author, and contextPct", () => {
    const s = new TurnStatus({
      model: "m",
      repoDisplay: "r",
      style: "simple",
      brandFilename: "grok.webp",
      authorName: "Grok Build",
    });
    s.contextUsedHighWater = 13_000;
    s.contextWindowSize = 100_000;
    const input = s.toInput();
    expect(input.style).toBe("simple");
    expect(input.brandFilename).toBe("grok.webp");
    expect(input.authorName).toBe("Grok Build");
    expect(input.contextPct).toBe(13);
  });

  it("keeps gifUrl across toInput after later activity updates", () => {
    const s = new TurnStatus({
      model: "m",
      repoDisplay: "r",
      style: "simple",
      gifUrl: "https://cdn.example/stable.gif",
    });
    expect(s.toInput().gifUrl).toBe("https://cdn.example/stable.gif");
    s.setAction("Reading files…");
    s.pushActivity("Read foo.ts");
    expect(s.toInput().gifUrl).toBe("https://cdn.example/stable.gif");
  });
});
