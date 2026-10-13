import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyTurnLifecycle } from "../packages/adapters/src/agy-lifecycle.js";
import {
  observeOwnedProcessGroups,
  ownedProcessGroupAlive,
  registerOwnedProcessGroup,
  registeredProcessGroup,
  terminateProcessGroup,
  type ProcessGroupOwnership,
} from "../packages/adapters/src/process-group.js";

const { ps } = vi.hoisted(() => ({ ps: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: ps,
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const identity = { pid: 197000901, pgid: 197000901, started: "Tue Oct 13 14:01:05 2026" };
let state: string;
let leaderPresent: boolean;
let started: string;
let members: string;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  state = "Z";
  leaderPresent = true;
  started = identity.started;
  members = `${identity.pgid} Z\n197000902 S\n`;
  ps.mockImplementation((_executable: string, args: string[]) => args[0] === "-p"
    ? leaderPresent ? `${identity.pid} ${state} ${identity.pgid} ${started}\n` : ""
    : members);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  observeOwnedProcessGroups(() => {});
  vi.restoreAllMocks();
  ps.mockReset();
});

describe("Darwin owned process-group liveness", () => {
  it("treats the observed zombie-only group as stopped despite signal-zero EPERM", () => {
    expect(ownedProcessGroupAlive(identity)).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("treats an absent leader and absent group as stopped", () => {
    leaderPresent = false;
    members = "197000902 S\n";
    expect(ownedProcessGroupAlive(identity)).toBe(false);
  });

  it("keeps a live descendant authoritative after the leader becomes a zombie", () => {
    members += `${identity.pgid} S\n`;
    expect(ownedProcessGroupAlive(identity)).toBe(true);
  });

  it("keeps a live descendant authoritative after the leader disappears", () => {
    leaderPresent = false;
    members += `${identity.pgid} S\n`;
    expect(ownedProcessGroupAlive(identity)).toBe(true);
  });

  it("does not signal a reused leader with a different start identity", async () => {
    started = "Tue Oct 13 14:02:05 2026";
    await expect(terminateProcessGroup(identity, 1)).resolves.toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("does not hide a failed process-table read", () => {
    const failure = new Error("ps failed");
    ps.mockImplementation((_executable: string, args: string[]) => {
      if (args[0] === "-ax") throw failure;
      return "";
    });
    expect(() => ownedProcessGroupAlive(identity)).toThrow(failure);
  });

  it("finishes post-output AGY cleanup and releases ownership without a poisoned next turn", async () => {
    const events: ProcessGroupOwnership[] = [];
    observeOwnedProcessGroups(event => events.push(event));
    state = "S";
    members = `${identity.pgid} S\n`;
    const child = Object.assign(new EventEmitter(), {
      pid: identity.pid, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      expect(pid).toBe(-identity.pgid);
      if (signal === 0 && state === "Z") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      if (signal === "SIGTERM") {
        state = "Z";
        members = `${identity.pgid} Z\n`;
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      }
      return true;
    });
    registerOwnedProcessGroup(child);
    const run = new AgyTurnLifecycle("completed-agy-turn", 10_000);
    run.attach(child, false, false);
    run.streaming = true;
    child.stdout!.emit("data", Buffer.from("SEAM_PRO_AGY_OK"));
    await expect(run.close()).resolves.toBeUndefined();
    await expect(run.done).resolves.toBeUndefined();
    await expect(run.close()).resolves.toBeUndefined();
    expect(registeredProcessGroup(child)).toBeUndefined();
    expect(events).toEqual([
      { type: "own_group", identity }, { type: "release_group", identity },
    ]);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-identity.pgid, "SIGTERM");
  });
});
