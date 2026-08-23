import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { PresetsFileSchema } from "../packages/core/src/config.js";
import { hashBridgeToken, mintBridgeToken, tokenMatchesHash } from "../packages/core/src/core/bridge-pairing.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;
let file: string;

function describeConfig(record: SessionRecord): ConfigDescription {
  return {
    sessionId: record.id,
    channelRef: record.channelRef,
    parentRef: record.parentRef,
    agent: { value: record.agentId, source: "session config" },
    model: { value: "m", source: "default" },
    effort: { value: null, source: "default" },
    cwd: { value: "/cwd", source: "default" },
    permission: { value: "ask", source: "default" },
    locked: false,
    detached: { value: false, source: "default" },
    tts: { value: false, source: "default" },
    ttsVoice: { value: null, source: "default" },
    location: { value: "local", source: "default" },
  };
}

function makeService(): ConfigMutationService {
  const maps = {
    channelPresets: new Map(),
    threadPresets: new Map(),
    bridgePresets: new Map(),
  };
  return new ConfigMutationService({
    store,
    describeConfig,
    profiles: new Map([["claude", { id: "claude" } as AgentProfile]]),
    defaultModel: "x",
    presetsFile: file,
    tierCEnabled: true,
    reloadPresets: () => reloadChannelPresets(maps, file, silent),
    reschedule: () => {},
    defaultTimezone: "UTC",
    logger: silent,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-bridge-pair-"));
  file = path.join(dir, "channel-presets.json");
  store = new SessionStore(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("bridge pairing (#83 audit, #86 presets)", () => {
  const actor = { id: "1487094572696867019", name: "admin" };

  it("pair writes a config_audit row with actor id+name and bridgeId", () => {
    const svc = makeService();
    const token = mintBridgeToken();
    const result = svc.applyBridgePair({
      name: "mac",
      tokenHash: hashBridgeToken(token),
      emoji: "🖥️",
      actor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bridgeId).toBe("mac");
    const rows = store.listConfigMutations(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.tier).toBe("bridge");
    expect(row.actorId).toBe(actor.id);
    expect(row.actorName).toBe(actor.name);
    expect(row.scope).toBe("bridge:mac");
    expect(row.summary).toMatch(/pair/);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    expect(raw.bridges.mac.tokenHash).toBe(hashBridgeToken(token));
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(tokenMatchesHash(token, raw.bridges.mac.tokenHash)).toBe(true);
  });

  it("rotate writes a new audit row and replaces the token hash", () => {
    const svc = makeService();
    const first = mintBridgeToken();
    svc.applyBridgePair({ name: "mac", tokenHash: hashBridgeToken(first), actor });
    const second = mintBridgeToken();
    const result = svc.applyBridgeRotate({
      bridgeId: "mac",
      tokenHash: hashBridgeToken(second),
      actor,
    });
    expect(result.ok).toBe(true);
    const rows = store.listConfigMutations(10);
    expect(rows.some((r) => r.summary.includes("rotate"))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(tokenMatchesHash(second, raw.bridges.mac.tokenHash)).toBe(true);
    expect(tokenMatchesHash(first, raw.bridges.mac.tokenHash)).toBe(false);
  });

  it("PresetsFileSchema accepts bridges without a per-thread location field", () => {
    const parsed = PresetsFileSchema.safeParse({
      bridges: {
        mac: {
          tokenHash: "a".repeat(64),
          emoji: "🖥️",
          shortName: "mac",
          workspaceRoot: "/tmp/ws",
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.bridges.mac).not.toHaveProperty("location");
    expect(JSON.stringify(parsed.data)).not.toMatch(/agentId@/);
  });
});
