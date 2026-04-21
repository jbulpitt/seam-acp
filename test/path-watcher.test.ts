import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractCandidatePaths,
  readFilesFromText,
} from "../src/agents/path-watcher.js";

describe("extractCandidatePaths", () => {
  it("finds known-extension paths in narration", () => {
    const text =
      "I saved it to .playwright-mcp/page-2026.png and also notes.md";
    const got = extractCandidatePaths(text);
    expect(got).toContain(".playwright-mcp/page-2026.png");
    expect(got).toContain("notes.md");
  });

  it("finds paths inside markdown link syntax", () => {
    const text = "[Screenshot](runbook.png) is ready";
    expect(extractCandidatePaths(text)).toContain("runbook.png");
  });

  it("ignores unknown extensions", () => {
    expect(extractCandidatePaths("foo.exe and bar.dmg")).toEqual([]);
  });

  it("ignores tokens that aren't path-shaped", () => {
    expect(extractCandidatePaths("plain prose with no.files")).toEqual([]);
  });

  it("dedupes repeated mentions", () => {
    const got = extractCandidatePaths(
      "see chart.png — yes, chart.png — definitely chart.png"
    );
    expect(got).toEqual(["chart.png"]);
  });

  it("handles absolute paths", () => {
    const got = extractCandidatePaths("/tmp/screenshot.png");
    expect(got).toEqual(["/tmp/screenshot.png"]);
  });
});

describe("readFilesFromText", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "seam-pwatch-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reads a relative path under cwd and returns its bytes", async () => {
    await fs.writeFile(path.join(tmp, "hello.png"), "PNGDATA");
    const seen = new Set<string>();
    const got = await readFilesFromText("Saved it to hello.png", {
      roots: [tmp],
      seen,
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.filename).toBe("hello.png");
    expect(got[0]?.mimeType).toBe("image/png");
    expect(got[0]?.data.toString()).toBe("PNGDATA");
    expect(seen.has(got[0]!.absPath)).toBe(true);
  });

  it("dedupes via the shared seen set", async () => {
    await fs.writeFile(path.join(tmp, "x.png"), "X");
    const seen = new Set<string>();
    const a = await readFilesFromText("x.png", { roots: [tmp], seen });
    const b = await readFilesFromText("x.png again", { roots: [tmp], seen });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("rejects paths that escape the roots", async () => {
    const got = await readFilesFromText("/etc/passwd.txt", {
      roots: [tmp],
      seen: new Set(),
    });
    expect(got).toEqual([]);
  });

  it("accepts absolute paths if they're under a root", async () => {
    const sub = path.join(tmp, "out");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "abs.csv"), "a,b\n");
    const got = await readFilesFromText(`Saved to ${sub}/abs.csv`, {
      roots: [tmp],
      seen: new Set(),
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.mimeType).toBe("text/csv");
  });

  it("skips empty files and unknown extensions", async () => {
    await fs.writeFile(path.join(tmp, "empty.png"), "");
    await fs.writeFile(path.join(tmp, "weird.exe"), "x");
    const got = await readFilesFromText("empty.png and weird.exe", {
      roots: [tmp],
      seen: new Set(),
    });
    expect(got).toEqual([]);
  });

  it("returns nothing when no roots are configured", async () => {
    await fs.writeFile(path.join(tmp, "x.png"), "X");
    const got = await readFilesFromText("x.png", {
      roots: [],
      seen: new Set(),
    });
    expect(got).toEqual([]);
  });
});
