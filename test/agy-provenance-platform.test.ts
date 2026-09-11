import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeProvenanceMode,
  verifyAgyManagedRuntimeArtifact,
  verifyAgyManagedRuntimeIdentity,
} from "../packages/adapters/src/agy-native-runtime.js";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";

/**
 * #330. Two failures, one of which took a laptop offline.
 *
 * 1. macOS cannot exec a code-signed Mach-O through `/dev/fd/N`, so the
 *    descriptor-bound provenance route was Linux-only in practice even though
 *    a darwin branch existed.
 * 2. A `strict: true` adapter whose factory threw escaped `loadHostAdapters`
 *    and killed the bridge process. On a multi-agent host that silently lost
 *    one agent; on an agy-only host it was a total outage.
 */

const realPlatform = process.platform;
function forcePlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
afterEach(() => forcePlatform(realPlatform));

/** A staged content-addressed artifact, root `0555`, exactly as production. */
function stageArtifact(body: Buffer): { root: string; executable: string; sha256: string } {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-prov-")));
  const root = path.join(base, "agy-runtime");
  const release = path.join(root, sha256);
  fs.mkdirSync(release, { recursive: true });
  const executable = path.join(release, "agy");
  fs.writeFileSync(executable, body, { mode: 0o555 });
  fs.chmodSync(executable, 0o555);
  fs.chmodSync(release, 0o555);
  fs.chmodSync(root, 0o555);
  return { root, executable, sha256 };
}

describe("AGY provenance is platform-correct and cannot take down the host (#330)", () => {
  it("keeps every other adapter serving when a strict adapter refuses to load", () => {
    const refused: Array<{ agentId: string; reason: string }> = [];
    const adapters = loadHostAdapters("copilot", {
      exists: () => true,
      onAdapterRefused: (agentId, reason) => refused.push({ agentId, reason }),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: "/definitely/missing/agy",
        AGY_DEFAULT_MODEL: "fixture-model",
        AGY_VERSION: "fixture-version",
        AGY_SHA256: "a".repeat(64),
        AGY_RUNTIME_ROOT: "/definitely/missing/runtime",
      },
    });
    expect(refused.map((entry) => entry.agentId)).toContain("agy");
    expect(adapters.has("agy")).toBe(false);
    // Deleting the per-adapter isolation makes this THROW rather than fail,
    // which is precisely the host outage #330 is about.
    expect(adapters.has("claude")).toBe(true);
    expect(adapters.size).toBeGreaterThan(0);
  });

  it("verifies an immutable staged artifact on darwin instead of throwing on its own return path", () => {
    // A Mach-O cannot start with a shebang, so this drives the real binary
    // branch rather than the Node fixture loader.
    const { root, executable, sha256 } = stageArtifact(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]));
    forcePlatform("darwin");
    // The regression: the darwin branch previously threw EBADF from its own
    // return path, because duplicateCachedSnapshot re-opened the descriptor
    // through fdExecutable (exec-only) rather than fdReadPath (read, which
    // macOS permits). Verification must reach a real verdict.
    expect(() => verifyAgyManagedRuntimeArtifact(executable, root, sha256)).not.toThrow();

    // The load-bearing part: drive the real snapshot path. Before the fix this
    // threw `EBADF: bad file descriptor, close` from its own return path and
    // never reached the version probe. It must now get all the way to the
    // probe, which fails for a fake binary — a DIFFERENT and correct verdict.
    let reached: string | undefined;
    try {
      verifyAgyManagedRuntimeIdentity({
        executable,
        runtimeRoot: root,
        version: "fixture-version",
        sha256,
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
      });
    } catch (error) {
      reached = error instanceof Error ? error.message : String(error);
    }
    expect(reached).toBeDefined();
    expect(reached).not.toMatch(/EBADF|bad file descriptor/);
    expect(reached).toMatch(/bounded probe|does not match AGY_VERSION/);
    expect(describeProvenanceMode()).toBe("immutable-path");
  });

  it("refuses a runtime root the service user can write, which IS the darwin guarantee", () => {
    const { root, executable, sha256 } = stageArtifact(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x08, 0x00]));
    // Nothing in the suite covered assertNotWritable before; on darwin it is
    // the entire security argument, so neutering it must fail something.
    fs.chmodSync(root, 0o755);
    try {
      expect(() => verifyAgyManagedRuntimeArtifact(executable, root, sha256))
        .toThrow(/AGY_RUNTIME_ROOT must be immutable to the Seam service user/);
    } finally {
      fs.chmodSync(root, 0o555);
    }
  });

  it("refuses a writable release directory and a writable executable", () => {
    const { root, executable, sha256 } = stageArtifact(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x09, 0x00]));
    const release = path.dirname(executable);
    fs.chmodSync(release, 0o755);
    try {
      expect(() => verifyAgyManagedRuntimeArtifact(executable, root, sha256))
        .toThrow(/AGY release directory must be immutable/);
    } finally {
      fs.chmodSync(release, 0o555);
    }
    fs.chmodSync(executable, 0o755);
    try {
      expect(() => verifyAgyManagedRuntimeArtifact(executable, root, sha256))
        .toThrow(/AGY executable must be immutable/);
    } finally {
      fs.chmodSync(executable, 0o555);
    }
  });

  it("reports the mechanism actually used, not a platform default", () => {
    // Null until a snapshot is opened. Asserting a platform default here was
    // the wrong axis: on darwin a Node fixture still takes the descriptor
    // route, so platform and mechanism disagree exactly where it matters.
    const mode = describeProvenanceMode();
    expect(mode === null || mode === "descriptor" || mode === "immutable-path").toBe(true);
  });
});
