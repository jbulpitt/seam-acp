import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const script = path.resolve("scripts/install-macos-bridge.sh");

describe("install-macos-bridge.sh parser", () => {
  it("passes --self-test (canonical line, Discord paste, flag order, missing token)", () => {
    const out = execFileSync("bash", [script, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toContain("all parser tests passed");
  });
});
