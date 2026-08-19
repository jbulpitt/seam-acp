import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAttachmentWithinRoot,
  resolveAttachmentPath,
  AttachmentPathError,
  ATTACH_MAX_BYTES,
} from "@seam/adapters";

describe("readAttachment path jail (§4.2)", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-attach-root-"));
    cwd = path.join(root, "proj");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "ok.txt"), "hello");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads a cwd-relative file inside the workspace root", async () => {
    const att = await readAttachmentWithinRoot(cwd, "ok.txt", root);
    expect(att.filename).toBe("ok.txt");
    expect(Buffer.from(att.bytes).toString("utf8")).toBe("hello");
  });

  it("rejects a path escape via ..", async () => {
    const outside = path.join(os.tmpdir(), `seam-attach-secret-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret");
    try {
      await expect(
        resolveAttachmentPath(cwd, path.relative(cwd, outside), root)
      ).rejects.toThrow(AttachmentPathError);
      await expect(readAttachmentWithinRoot(cwd, "../../etc/passwd", root)).rejects.toMatchObject({
        code: "escape",
      });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects an absolute path outside the workspace root", async () => {
    await expect(readAttachmentWithinRoot(cwd, "/etc/hosts", root)).rejects.toMatchObject({
      code: "escape",
    });
  });

  it("honors the 25 MB cap", () => {
    expect(ATTACH_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
