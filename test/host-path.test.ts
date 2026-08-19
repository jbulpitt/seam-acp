import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveHostPath } from "../src/core/host-path.js";

describe("resolveHostPath", () => {
  it("uses an absolute path as-is", () => {
    expect(resolveHostPath("/etc/hostname")).toBe("/etc/hostname");
  });

  it("resolves a relative path against process.cwd()", () => {
    expect(resolveHostPath("foo/bar.txt")).toBe(path.resolve("foo/bar.txt"));
  });

  it("rejects an empty path", () => {
    expect(() => resolveHostPath("  ")).toThrow(/empty/);
  });
});
