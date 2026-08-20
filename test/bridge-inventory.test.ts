import { describe, it, expect } from "vitest";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";

describe("loadHostAdapters", () => {
  it("skips adapters whose CLI is not on PATH (agy must not spawn ENOENT)", () => {
    const adapters = loadHostAdapters("copilot", (bin) => bin === "copilot");
    expect([...adapters.keys()]).toEqual(["copilot"]);
    expect(adapters.has("agy")).toBe(false);
  });
});
