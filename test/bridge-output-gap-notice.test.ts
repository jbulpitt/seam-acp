import { testSessionRouter } from "./helpers/session-fixture.js";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { createOutputLog } from "../packages/bridge/src/output-log.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});
const drain = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

async function setup(location: string, adopted: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-output-gap-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const server = createServer();
  const config = { ...visualConfig, DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(),
    bridgePresets: new Map(), channelPresets: new Map(), threadPresets: new Map() } as any;
  const hub = new BridgeHub({ logger, config, httpServer: server, mutation: {} as any,
    healthPort: 3000, dataDir: dir, localBridgeTokenHash: "a".repeat(64) });
  cleanups.push(() => hub.close());
  const adapter = { sendMessage: vi.fn(async (channel: any, _text: string) => ({ channel, id: "notice" })) };
  const router = testSessionRouter({ getRuntime: vi.fn(), describeConfig: () => ({ location: { value: location },
    agent: { value: "claude" }, model: { value: "test" }, role: { value: "worker" },
    disableThreadPrefix: { value: false } }) });
  const orch = new Orchestrator({ logger, config, store, router: router as any, adapter: adapter as any,
    renderer: discordRenderer as any, modelCatalog: fixtureModelCatalog([]) });
  orch.setBridgeHub(hub);
  const mux = (hub as any).ensureMux(location) as ReturnType<typeof hub.muxFor> & {};
  const log = createOutputLog({ maxFramesPerSlot: 2 });
  const commands: Array<Record<string, any>> = [];
  let slot = 6;
  class Socket extends EventEmitter {
    readyState = 1;
    send(raw: string) {
      const cmd = JSON.parse(raw);
      commands.push(cmd);
      if (cmd.type !== "cmd") return;
      const replay = log.since(slot, cmd.payload?.afterSeq ?? 0);
      const payload = cmd.action === "listSlots" ? { slots: [slot] }
        : cmd.action === "replayOutput" ? { slot, ...replay,
          frames: replay.frames.map(frame => ({ seq: frame.seq, type: frame.type, ...frame.payload })) } : {};
      queueMicrotask(() => this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId, payload }));
    }
    close() {}
    ping() {}
    deliver(frame: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
  }
  const socket = new Socket();
  mux.attach(socket as any);
  const child = adopted ? undefined : mux.spawn();
  if (child) slot = child.slot;
  cleanups.push(() => {
    socket.readyState = 3;
    socket.emit("close");
    if (mux.isBound(slot)) (child ?? rebound)?.detach();
  });
  let rebound: ReturnType<typeof mux.adopt> | undefined;
  const chunks: string[] = [];
  child?.stdout.on("data", chunk => chunks.push(String(chunk)));
  const replay = async (overflow = true) => {
    for (let i = 1; i <= (overflow ? 4 : 2); i++) log.append(slot, "data", { data: `frame-${i}\n` });
    if (adopted) {
      rebound = mux.adopt(slot, { afterSeq: 0 });
      rebound.stdout.on("data", chunk => chunks.push(String(chunk)));
    } else {
      socket.deliver({ type: "hello", instanceId: "same-instance" });
      await drain();
      socket.deliver({ type: "hello", instanceId: "same-instance" });
    }
    await drain();
  };
  const own = (source: "inbound" | "dispatch" | "schedule", ownerLocation = location) => {
    const now = new Date().toISOString();
    store.turnAttempts.registerOwner("controller");
    const attempt = store.turnAttempts.claim({ id: "attempt", target: "thread", prompt: "the original task",
      session: source === "inbound" ? "live" : "isolated", kind: "parked", createdUtc: now },
      "identity", "controller", source);
    store.turnAttempts.bind(attempt, "same-acp");
    store.turnAttempts.startPrompt(attempt);
    store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: ownerLocation, slot,
      submissionId: "submission", acpSessionId: "same-acp", delegatedUtc: now });
    if (adopted) store.turnAttempts.suspendBoot("controller");
    return store.turnAttempts.get(attempt.id)!;
  };
  return { store, hub, router, adapter, logger, commands, slot, own, replay, chunks };
}

describe("bridge output-gap notice", () => {
  it.each([
    ["local", false, "inbound"], ["remote", true, "inbound"],
    ["remote", true, "dispatch"], ["local", true, "schedule"],
  ] as const)("notifies the %s %s %s owner of real retention loss without replaying work", async (location, adopted, source) => {
    const h = await setup(location, adopted);
    const attempt = h.own(source);
    await h.replay();
    expect(h.logger.error).toHaveBeenCalledWith({ bridgeId: location, slot: h.slot,
      afterSeq: 0, firstAvailableSeq: 3, droppedFrames: 2 }, expect.any(String));
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
    const [channel, notice] = h.adapter.sendMessage.mock.calls[0]!;
    expect(channel).toEqual({ platform: "discord", id: "thread" });
    expect(notice).toContain("output was lost");
    expect(notice).toContain(location);
    expect(notice).toContain(String(h.slot));
    expect(notice).toContain("cursor 0");
    expect(notice).toContain("frame 3");
    expect(notice).toContain("2 dropped");
    expect(h.store.turnAttempts.get(attempt.id)).toEqual(attempt);
    expect(h.chunks.join("")).toBe("frame-3\nframe-4\n");
    expect(h.commands.filter(cmd => cmd.type === "kill" || cmd.type === "data")).toEqual([]);
  });

  it("uses the live runtime's existing host and slot binding when no turn owns recovery", async () => {
    const h = await setup("local", false);
    const now = new Date().toISOString();
    h.store.upsert({ id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: null,
      agentId: "claude", acpSessionId: "same-acp", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now });
    h.hub.markSessionBridge("discord:thread", "local");
    h.router.getRuntime.mockReturnValue({ getSlot: () => h.slot });
    await h.replay();
    expect(h.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.adapter.sendMessage.mock.calls[0]![0].id).toBe("thread");
  });

  it("does not route another host's identical slot number to this thread", async () => {
    const h = await setup("local", true);
    h.own("inbound", "different-host");
    await h.replay();
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("does not invent a loss notice when replay is intact", async () => {
    const h = await setup("local", true);
    h.own("inbound");
    await h.replay(false);
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.chunks.join("")).toBe("frame-1\nframe-2\n");
  });
});
