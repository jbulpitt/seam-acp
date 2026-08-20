/**
 * PR4 / D9 / D10 / #84 remainder / #86 — location binding.
 *
 * Default location is local; binding round-trips presets + audit;
 * markSessionBridge is called on start when location is a bridge id;
 * threads() includes agentId@location.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { scanWorkspaces } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { LoopbackHost } from "../packages/core/src/core/loopback-host.js";
import { SeamTokenRegistry } from "../packages/core/src/core/mcp/token-registry.js";
import {
  formatAgentAtLocation,
  listAgentLocationChoices,
  listHosts,
  parseAgentAtLocation,
  parseDispatchWorker,
} from "../packages/core/src/core/location.js";
import { resolveThreadLocation } from "../packages/core/src/config.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ThreadPreset, BridgeHostConfig } from "../packages/core/src/config.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function stubProfile(id: string, spawnCalls: unknown[]): AgentProfile {
  return {
    id,
    displayName: id,
    spawn(model?: string, effort?: string) {
      spawnCalls.push({ model, effort });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill() {},
      });
    },
  } as unknown as AgentProfile;
}

function stubStore(): SessionStore {
  return {
    readConfig: (record: SessionRecord): SessionConfigState => {
      if (!record.configJson) return {};
      try {
        return JSON.parse(record.configJson) as SessionConfigState;
      } catch {
        return {};
      }
    },
  } as unknown as SessionStore;
}

function makeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "opus" } satisfies SessionConfigState),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("default location is local (#86)", () => {
  it("resolveThreadLocation and describeConfig default to local when omitted", () => {
    expect(resolveThreadLocation({ threadPresets: new Map() }, "thread-1")).toBe("local");
    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [stubProfile("claude", [])],
      defaultAgentId: "claude",
      defaultModel: "opus",
      threadPresets: new Map(),
    });
    const d = router.describeConfig(makeRecord());
    expect(d.location).toEqual({ value: "local", source: "default" });
  });

  it("describeConfig sources location from the thread preset", () => {
    const threadPresets = new Map<string, ThreadPreset>([["thread-1", { location: "mac" }]]);
    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [stubProfile("claude", [])],
      defaultAgentId: "claude",
      defaultModel: "opus",
      threadPresets,
    });
    expect(router.describeConfig(makeRecord()).location).toEqual({
      value: "mac",
      source: "thread preset",
    });
  });
});

describe("markSessionBridge is called on start when location is a bridge id (#84)", () => {
  it("binds the session to the thread-preset location before planning remote spawn", () => {
    const marked: Array<{ sessionId: string; location: string }> = [];
    const sessionBridge = new Map<string, string>();
    const localSpawnCalls: unknown[] = [];
    const threadPresets = new Map<string, ThreadPreset>([["thread-1", { location: "mac" }]]);
    const registry = new SeamTokenRegistry();
    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [stubProfile("claude", localSpawnCalls)],
      defaultAgentId: "claude",
      defaultModel: "opus",
      threadPresets,
      bindSessionLocation: (sessionId, location) => {
        marked.push({ sessionId, location });
        if (location === "local") sessionBridge.delete(sessionId);
        else sessionBridge.set(sessionId, location);
      },
      seamMcp: {
        registry,
        getPort: () => 18765,
        isRemoteSession: (sessionId) => sessionBridge.has(sessionId),
        muxForSession: () => undefined,
      },
    });

    const record = makeRecord();
    expect(() => router.planRuntimeSpawn(record)).toThrow(/not connected/);
    expect(marked).toEqual([{ sessionId: "discord:thread-1", location: "mac" }]);
    expect(sessionBridge.get("discord:thread-1")).toBe("mac");
    expect(localSpawnCalls).toHaveLength(0);
  });

  it("does not mark a local thread (unbound ⇒ loopback MCP)", () => {
    const marked: Array<{ sessionId: string; location: string }> = [];
    const localSpawnCalls: unknown[] = [];
    const registry = new SeamTokenRegistry();
    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [stubProfile("claude", localSpawnCalls)],
      defaultAgentId: "claude",
      defaultModel: "opus",
      threadPresets: new Map(),
      seamMcp: {
        registry,
        getPort: () => 18765,
        isRemoteSession: () => false,
        bindSessionLocation: (sessionId, location) => {
          marked.push({ sessionId, location });
        },
      },
    });
    const plan = router.planRuntimeSpawn(makeRecord());
    expect(plan.remote).toBe(false);
    expect(marked).toEqual([{ sessionId: "discord:thread-1", location: "local" }]);
    plan.spawnChild(plan.model, plan.effort);
    expect(localSpawnCalls).toHaveLength(1);
  });
});

describe("threads() includes @location (#84)", () => {
  it("formats agentId@location with host emoji", () => {
    expect(formatAgentAtLocation("claude", "mac")).toBe("claude@mac");
    expect(formatAgentAtLocation("claude", undefined)).toBe("claude@local");
  });

  it("parseDispatchWorker splits agentId@location and snowflake threads", () => {
    expect(parseDispatchWorker("111111111111111111")).toEqual({
      kind: "thread",
      threadId: "111111111111111111",
    });
    expect(parseDispatchWorker("claude@mac")).toEqual({
      kind: "named",
      name: "claude",
      location: "mac",
    });
    expect(parseDispatchWorker("reviewer")).toEqual({ kind: "named", name: "reviewer" });
  });
});

describe("flattened host-prefixed picker (D10)", () => {
  it("lists every agentId@location prefixed by host emoji", () => {
    const bridges = new Map<string, BridgeHostConfig>([
      [
        "mac",
        {
          id: "mac",
          emoji: "💻",
          shortName: "mac",
          tokenHash: "a".repeat(64),
        },
      ],
    ]);
    const hosts = listHosts({ bridges: bridges.values(), connected: new Set(["mac"]) });
    const choices = listAgentLocationChoices({
      profiles: [
        { id: "claude", displayName: "Claude" },
        { id: "grok", displayName: "Grok" },
      ],
      hosts,
      agentsByHost: new Map([["mac", new Set(["claude", "grok"])]]),
    });
    expect(choices.map((c) => c.value)).toEqual([
      "claude@local",
      "grok@local",
      "claude@mac",
      "grok@mac",
    ]);
    expect(choices[0]!.label.startsWith("🏠")).toBe(true);
    expect(choices[2]!.label.startsWith("💻")).toBe(true);
    expect(parseAgentAtLocation(choices[2]!.value)).toEqual({
      agentId: "claude",
      location: "mac",
      explicit: true,
    });
  });

  it("remote hosts only list advertised installed agents", () => {
    const bridges = new Map<string, BridgeHostConfig>([
      [
        "media-server",
        {
          id: "media-server",
          emoji: "🖥️",
          shortName: "media-server",
          tokenHash: "b".repeat(64),
        },
      ],
    ]);
    const hosts = listHosts({
      bridges: bridges.values(),
      connected: new Set(["media-server"]),
    });
    const choices = listAgentLocationChoices({
      profiles: [
        { id: "claude", displayName: "Claude" },
        { id: "copilot", displayName: "Copilot" },
        { id: "grok", displayName: "Grok" },
      ],
      hosts,
      agentsByHost: new Map([["media-server", new Set(["grok"])]]),
    });
    expect(choices.map((c) => c.value)).toEqual([
      "claude@local",
      "copilot@local",
      "grok@local",
      "grok@media-server",
    ]);
  });

  it("does not invent VPS agents on a remote host with no inventory", () => {
    const bridges = new Map<string, BridgeHostConfig>([
      ["mac", { id: "mac", tokenHash: "c".repeat(64) }],
    ]);
    const hosts = listHosts({ bridges: bridges.values(), connected: new Set() });
    const choices = listAgentLocationChoices({
      profiles: [{ id: "claude", displayName: "Claude" }],
      hosts,
    });
    expect(choices.map((c) => c.value)).toEqual(["claude@local"]);
  });
});

describe("D9 loopback host + D11 workspace scan", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loopback rpc listWorkspaces scans the host root (same adapter-over-bus method)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ws-"));
    fs.mkdirSync(path.join(tmp, "alpha"));
    fs.mkdirSync(path.join(tmp, "beta"));
    fs.mkdirSync(path.join(tmp, ".hidden"));
    const loopback = new LoopbackHost({
      adapters: [stubProfile("claude", [])],
      workspaceRoot: tmp,
    });
    const listed = (await loopback.rpc("listWorkspaces", {})) as Array<{ path: string; name: string }>;
    expect(listed.map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(listed.every((w) => w.path.startsWith(tmp))).toBe(true);
    expect(scanWorkspaces(tmp).map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
  });
});
