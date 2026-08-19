import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { zipOneFile } from "../src/core/zip-one.js";

describe("zipOneFile", () => {
  it("produces a zip python can extract", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "seam-zip-"));
    try {
      const src = path.join(dir, "hello.txt");
      await writeFile(src, "hello seam\n");
      const zipBuf = await zipOneFile(src);
      expect(zipBuf.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
      const zipPath = path.join(dir, "hello.txt.zip");
      await writeFile(zipPath, zipBuf);
      const out = execFileSync(
        "python3",
        ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read('hello.txt').decode())", zipPath],
        { encoding: "utf8" }
      );
      expect(out.trimEnd()).toBe("hello seam");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
