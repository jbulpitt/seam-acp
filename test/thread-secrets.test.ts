import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeThreadSecret,
  listThreadSecrets,
  secretHarnessRules,
  consumeThreadSecrets,
  assertSecretName,
} from "../packages/core/src/core/thread-secrets.js";

describe("thread secrets", () => {
  it("rejects a bad name", () => {
    expect(() => assertSecretName("has space")).toThrow();
    expect(() => assertSecretName("../etc")).toThrow();
  });

  it("writes  a 0600 file, lists by name, and consumes the directory", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "seam-sec-"));
    try {
      const written = await writeThreadSecret(dataDir, "thread-1", "API_KEY", "s3cret");
      expect(written.name).toBe("API_KEY");
      const body = await readFile(written.absPath, "utf8");
      expect(body).toBe("s3cret");
      const listed = await listThreadSecrets(dataDir, "thread-1");
      expect(listed.map((s) => s.name)).toEqual(["API_KEY"]);
      const rules = secretHarnessRules(listed);
      expect(rules[0]).toContain(written.absPath);
      expect(rules[0]).not.toContain("s3cret");
      await consumeThreadSecrets(dataDir, "thread-1");
      expect(await listThreadSecrets(dataDir, "thread-1")).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
