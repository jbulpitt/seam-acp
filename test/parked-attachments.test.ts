import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PARKED_ATTACH_MAX_BYTES,
  saveParkedAttachment,
  deleteParkedAttachmentDir,
  loadParkedAttachmentBytes,
  loadParkedAttachments,
} from "../packages/core/src/core/parked-prompts/attachments.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-parked-att-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parked-prompt attachments (#88 D6)", () => {
  it("caps at the 25 MB attach limit", () => {
    expect(PARKED_ATTACH_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("round-trips bytes and sanitizes the filename", async () => {
    const saved = await saveParkedAttachment(dir, "park-1", {
      filename: "../evil/note.txt",
      mime: "text/plain",
      bytes: Buffer.from("hello"),
    });
    expect(saved.filename).toBe("note.txt");
    const bytes = await loadParkedAttachmentBytes(dir, "park-1", saved);
    expect(bytes?.toString()).toBe("hello");
    const asMsg = await loadParkedAttachments(dir, "park-1", [saved]);
    expect(asMsg[0]?.url).toMatch(/^data:text\/plain;base64,/);
  });

  it("deleteParkedAttachmentDir removes the files", async () => {
    const saved = await saveParkedAttachment(dir, "park-1", {
      filename: "a.txt",
      mime: "text/plain",
      bytes: Buffer.from("x"),
    });
    await deleteParkedAttachmentDir(dir, "park-1");
    expect(await loadParkedAttachmentBytes(dir, "park-1", saved)).toBeNull();
  });
});
