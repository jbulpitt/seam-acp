/**
 * #443 — the runtime acts on one remote slot, and only on a report.
 *
 * The bridge is stubbed. What is under test is that a quiet prompt asks,
 * and that the two answers do opposite things to THIS turn: restart kills
 * the slot, retry re-prompts it, and a bridge that cannot answer changes
 * nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { readErrorClassification, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

function runtime(opts: {
  sendCmd: (action: string, payload: unknown) => Promise<unknown>;
  prompt: () => Promise<unknown>;
  sessionId?: string;
  kill?: () => void;
  onDead?: () => void;
}) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
  const profile = { id: "grok", spawn: () => { throw new Error("unused"); } } as unknown as AgentProfile;
  const rt = new AgentRuntime({
    profile,
    logger: logger as unknown as Logger,
    bridgeHealth: { sendCmd: opts.sendCmd },
    hangSilenceMs: 20,
    onDead: opts.onDead,
  });
  Object.assign(rt, {
    connection: { prompt: opts.prompt },
    sessionId: opts.sessionId ?? "thread-1",
    promptCapabilities: {},
    child: { slot: 4, kill: opts.kill ?? vi.fn(), killed: false },
  });
  return { rt, logger };
}

describe("#443 remote hang watch", () => {
  it("restarts only the silent slot whose event loop did not answer", async () => {
    const kill = vi.fn();
    const onDead = vi.fn();
    const sendCmd = vi.fn(async (action: string) => {
      expect(action).toBe("probeHang");
      return { probe: "unanswered", providerSocket: "unavailable" };
    });
    const { rt, logger } = runtime({
      sendCmd,
      prompt: () => new Promise(() => {}),
      kill,
      onDead,
    });
    const thrown = await rt.prompt("still thinking?").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/did not answer seam\/hangProbe/);
    expect(readErrorClassification(thrown)?.errorKind).toBe("connection_closed");
    expect(kill).toHaveBeenCalledOnce();
    expect(onDead).toHaveBeenCalledOnce();
    expect(sendCmd).toHaveBeenCalledWith("probeHang", { slot: 4 });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "restart", slot: 4 }), expect.stringMatching(/restarting this slot/));
  });

  it("retries the same process when the provider socket is not progressing", async () => {
    let calls = 0;
    const kill = vi.fn();
    const sendCmd = vi.fn(async () => ({ probe: "answered", providerSocket: "not_progressing" }));
    const { rt } = runtime({
      sendCmd,
      kill,
      prompt: () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return Promise.resolve({ stopReason: "end_turn" });
      },
    });
    await expect(rt.prompt("hello")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(calls).toBe(2);
    expect(kill).not.toHaveBeenCalled();
  }, 15_000);

  it("leaves a turn the bridge says is still working, and a turn whose bridge cannot probe", async () => {
    const kill = vi.fn();
    let release: (value: { stopReason: string }) => void = () => {};
    const sendCmd = vi.fn(async () => ({ probe: "answered", providerSocket: "progressing" }));
    const working = runtime({
      sendCmd,
      kill,
      prompt: () => new Promise((resolve) => { release = resolve; }),
    });
    const pending = working.rt.prompt("long tool");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sendCmd).toHaveBeenCalledWith("probeHang", { slot: 4 });
    expect(kill).not.toHaveBeenCalled();
    release({ stopReason: "end_turn" });
    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });

    const offline = vi.fn(async () => { throw new Error("Unknown action: probeHang"); });
    const kill2 = vi.fn();
    let release2: (value: { stopReason: string }) => void = () => {};
    const oldBridge = runtime({
      sendCmd: offline,
      kill: kill2,
      prompt: () => new Promise((resolve) => { release2 = resolve; }),
    });
    const pending2 = oldBridge.rt.prompt("long tool");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(offline).toHaveBeenCalled();
    expect(kill2).not.toHaveBeenCalled();
    release2({ stopReason: "end_turn" });
    await expect(pending2).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("does not probe a local runtime or a prompt that finishes quickly", async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
    const profile = { id: "grok", spawn: () => { throw new Error("unused"); } } as unknown as AgentProfile;
    const local = new AgentRuntime({ profile, logger: logger as unknown as Logger, hangSilenceMs: 5 });
    Object.assign(local, {
      connection: { prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }) },
      sessionId: "thread-1",
      promptCapabilities: {},
    });
    await expect(local.prompt("hi")).resolves.toMatchObject({ stopReason: "end_turn" });
  });
});
