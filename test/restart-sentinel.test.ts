import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sentinelIsForce,
  writeForceRestartSentinel,
  restartSentinelPath,
  RESTART_SENTINEL_FORCE_BODY,
} from "../packages/core/src/core/restart-sentinel.js";

describe("sentinelIsForce", () => {
  it("treats empty npm-run-redeploy sentinel as drain, not force", () => {
    expect(sentinelIsForce("")).toBe(false);
    expect(sentinelIsForce("\n")).toBe(false);
  });

  it("treats body force as skip-drain", () => {
    expect(sentinelIsForce("force")).toBe(true);
    expect(sentinelIsForce("force\n")).toBe(true);
    expect(sentinelIsForce("FORCE\n")).toBe(true);
  });
});

describe("writeForceRestartSentinel", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes data/.restart-pending with force body", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-sentinel-"));
    const written = writeForceRestartSentinel(tmp);
    expect(written).toBe(restartSentinelPath(tmp));
    expect(fs.readFileSync(written, "utf8")).toBe(RESTART_SENTINEL_FORCE_BODY);
    expect(sentinelIsForce(fs.readFileSync(written, "utf8"))).toBe(true);
  });
});
