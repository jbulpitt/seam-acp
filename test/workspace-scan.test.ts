import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanWorkspaces } from "@seam/adapters";

describe("scanWorkspaces", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ws-"));
    fs.mkdirSync(path.join(tmp, "alpha"));
    fs.mkdirSync(path.join(tmp, "beta"));
    fs.mkdirSync(path.join(tmp, ".hidden"));
    fs.writeFileSync(path.join(tmp, "file.txt"), "x");
    fs.symlinkSync(path.join(tmp, "alpha"), path.join(tmp, "alias"));
    return tmp;
  }

  it("lists real directories and skips hidden, files, and symlink dirs", () => {
    const root = setup();
    expect(scanWorkspaces(root).map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("does not treat a relocate leftover symlink as a second project", () => {
    const root = setup();
    const names = scanWorkspaces(root).map((w) => w.name);
    expect(names).toContain("alpha");
    expect(names).not.toContain("alias");
  });
});
