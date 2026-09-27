import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sweepExpiredHostSecrets,
  writeHostAttachment,
  writeHostSecret,
} from "../packages/bridge/src/host-files.js";

describe("bridge host files", () => {
  it("writes attachments under the bridge cwd when the requested cwd is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seam-host-file-"));
    const fallback = path.join(root, "workspace");
    await mkdir(fallback);
    try {
      const result = await writeHostAttachment({
        requestedCwd: path.join(root, "missing"),
        fallbackCwd: fallback,
        filename: "../report.pdf",
        base64: Buffer.from("pdf body").toString("base64"),
      });
      expect(result.path).toBe(path.join(fallback, ".seam-attachments", "report.pdf"));
      expect(await readFile(result.path, "utf8")).toBe("pdf body");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps secret values out of metadata, enforces 0600, and expires them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seam-host-secret-"));
    const value = "do-not-log-this-value";
    try {
      const result = await writeHostSecret({
        root,
        threadId: "123456789012345678",
        name: "TOKEN",
        base64: Buffer.from(value).toString("base64"),
        expiresAt: 2_000,
      });
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
      expect(await readFile(result.path, "utf8")).toBe(value);
      const metadata = await readFile(result.path + ".meta.json", "utf8");
      expect(metadata).not.toContain(value);

      await sweepExpiredHostSecrets(root, 2_001);
      await expect(stat(result.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(result.path + ".meta.json")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
