import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRestartSentinel,
  restartSentinelPath,
  restartSeamAcpProcess,
} from "../packages/core/src/core/restart-sentinel.js";

describe("writeRestartSentinel", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes an empty data/.restart-pending file", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-sentinel-"));
    const written = writeRestartSentinel(tmp);
    expect(written).toBe(restartSentinelPath(tmp));
    expect(fs.readFileSync(written, "utf8")).toBe("");
  });
});

describe("restartSeamAcpProcess", () => {
  it("signals the current process instead of invoking a supervisor CLI", async () => {
    const signalProcess = vi.fn(() => true);

    await restartSeamAcpProcess(signalProcess);

    expect(signalProcess).toHaveBeenCalledOnce();
    expect(signalProcess).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});
