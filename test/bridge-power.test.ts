import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { awakeProgram, macPowerStatus, MacPowerSkip, withHostAwake } from "../scripts/lib/bridge-power.mjs";

const target = { bridgeId: "portable", sshAlias: "portable", nodePath: "/opt/node/bin/node" };

function worker(eligible = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("finish", () => child.emit("close", 0, null));
  const launch = vi.fn(() => {
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ eligible, reason: eligible ? "AC power" : "battery 49% (requires 50% or AC)" })}\n`));
    return child;
  });
  return { child, launch };
}

describe("Mac rollout power and awake lifetime", () => {
  it.each([
    ["Now drawing from 'AC Power'\n20%; charging", true],
    ["Now drawing from 'Battery Power'\n50%; discharging", true],
    ["Now drawing from 'Battery Power'\n49%; discharging", false],
  ])("reads the actual pmset output %s", (text, eligible) => expect(macPowerStatus(text).eligible).toBe(eligible));

  it("reports the unreadable/unrecognized power state instead of treating it as safe", () => {
    expect(() => macPowerStatus("pmset unavailable")).toThrow("unrecognized pmset power state: pmset unavailable");
  });

  it("keeps the worker open throughout the rollout and closes it if the rollout throws", async () => {
    const f = worker();
    const error = new Error("scp: connection reset by peer");
    await expect(withHostAwake(target, "darwin-arm64", async () => {
      expect(f.child.stdin.writableEnded).toBe(false);
      throw error;
    }, f.launch)).rejects.toBe(error);
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(awakeProgram).toContain("['-i', '-s', '-w', String(process.pid)]");
  });

  it("skips an underpowered Mac before staging starts", async () => {
    const f = worker(false), operation = vi.fn();
    await expect(withHostAwake(target, "darwin-arm64", operation, f.launch)).rejects.toBeInstanceOf(MacPowerSkip);
    expect(operation).not.toHaveBeenCalled();
  });

  it("runs the same rollout on non-Macs without launching a power worker", async () => {
    const launch = vi.fn(), operation = vi.fn().mockResolvedValue("updated");
    await expect(withHostAwake(target, "linux-x64", operation, launch)).resolves.toBe("updated");
    expect(launch).not.toHaveBeenCalled();
  });
});
