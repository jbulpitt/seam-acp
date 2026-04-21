import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  isWithinRoot,
  normalizeFullPath,
  resolveRepoPath,
} from "../src/core/path-utils.js";

const tmp = os.tmpdir();

describe("normalizeFullPath", () => {
  it("returns absolute path", () => {
    const p = normalizeFullPath("./foo");
    expect(path.isAbsolute(p)).toBe(true);
  });

  it("strips quotes", () => {
    const p = normalizeFullPath('"/tmp/foo"');
    expect(p).toBe(path.resolve("/tmp/foo"));
  });
});

describe("isWithinRoot", () => {
  it("matches descendants", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(path.join(root, "a", "b"), root)).toBe(true);
  });

  it("matches root itself", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it("rejects sibling that shares prefix", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(path.join(tmp, "repos-other", "x"), root)).toBe(false);
  });

  it("rejects parent", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(tmp, root)).toBe(false);
  });

  it("rejects directory traversal", () => {
    const root = path.join(tmp, "repos");
    const escape = path.join(root, "..", "outside");
    expect(isWithinRoot(escape, root)).toBe(false);
  });
});

describe("resolveRepoPath", () => {
  it("joins relative input under root", () => {
    const root = path.join(tmp, "repos");
    expect(resolveRepoPath(root, "myrepo")).toBe(path.join(root, "myrepo"));
  });

  it("passes absolute paths through (still must be sandbox-checked)", () => {
    const root = path.join(tmp, "repos");
    const abs = path.join(tmp, "elsewhere");
    expect(resolveRepoPath(root, abs)).toBe(abs);
  });

  it("throws on empty input", () => {
    expect(() => resolveRepoPath(tmp, "")).toThrow();
  });
});
