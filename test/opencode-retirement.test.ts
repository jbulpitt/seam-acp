/**
 * #12 — the opencode / LM Studio agent surface is retired.
 *
 * These are removal regressions, so most of them assert absence: no profile
 * factory, no env schema keys, no bridge-inventory entry, no picker symbol, no
 * brand asset. The behaviour that is *added* is the migration path: a session
 * still bound to `opencode` must fail with an actionable message rather than a
 * bare "Unknown agent profile", and must never be silently rerouted to another
 * agent.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import * as adapters from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import {
  RETIRED_AGENTS,
  retiredAgent,
  retiredAgentMessage,
} from "../packages/core/src/core/retired-agents.js";
import { loadConfig } from "../packages/core/src/config.js";
import { resolveAgentBrand, loadBrandAsset } from "../packages/core/src/core/agent-brand.js";
import { DEFAULT_THREAD_NAMER_CONFIG } from "../packages/core/src/platforms/discord/thread-namer.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stubProfile(id: string): AgentProfile {
  return {
    id,
    displayName: id,
    spawn() {
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill() {},
      });
    },
  } as unknown as AgentProfile;
}

function stubStore(): SessionStore {
  return {
    readConfig: (record: SessionRecord): SessionConfigState => {
      try {
        return record.configJson ? (JSON.parse(record.configJson) as SessionConfigState) : {};
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

function makeRouter(): SessionRouter {
  return new SessionRouter({
    logger: silent,
    store: stubStore(),
    profiles: [stubProfile("claude")],
    defaultAgentId: "claude",
    defaultModel: "opus",
    threadPresets: new Map(),
  });
}

// --- the surface is gone -----------------------------------------------------

describe("#12 opencode surface removed", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function baseEnv(extra: Record<string, string | undefined>) {
    process.env = {
      ...saved,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: repoRoot,
      CHANNEL_PRESETS_FILE: undefined,
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  it("exports no opencode profile factory or LM Studio helpers", () => {
    const exported = Object.keys(adapters);
    expect(exported).not.toContain("makeOpencodeProfile");
    expect(exported).not.toContain("fetchLmStudioModels");
    expect(exported).not.toContain("syncOpencodeLmStudioConfig");
    expect(exported.filter((k) => /opencode|lmstudio/i.test(k))).toEqual([]);
  });

  it("ships no opencode profile module or brand asset", () => {
    expect(fs.existsSync(path.join(repoRoot, "packages/adapters/src/profiles/opencode.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "assets/agents/opencode.webp"))).toBe(false);
    expect(loadBrandAsset("opencode")).toBeNull();
  });

  it("offers no opencode symbol in the thread-namer picker", () => {
    expect(DEFAULT_THREAD_NAMER_CONFIG.agents.map((a) => a.match)).not.toContain("opencode");
  });

  it("leaves no OPENCODE_* key in the parsed config", () => {
    baseEnv({});
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    expect(Object.keys(cfg).filter((k) => k.startsWith("OPENCODE_"))).toEqual([]);
  });

  it("still boots when a deployment's .env carries the retired OPENCODE_* keys", () => {
    // The production .env kept all nine keys after retirement. Zod strips unknown
    // keys, so they must be inert: not a boot failure, and not a silent re-enable.
    baseEnv({
      OPENCODE_ENABLED: "true",
      OPENCODE_CLI_PATH: "/usr/local/bin/opencode",
      OPENCODE_DEFAULT_MODEL: "lmstudio-remote/google/gemma-4-26b-a4b",
      OPENCODE_LMSTUDIO_URL: "https://llm.example.com",
      OPENCODE_LMSTUDIO_API_KEY: "secret",
      OPENCODE_MODEL_PREFIX: "lmstudio-remote",
      OPENCODE_CONFIG_PATH: "/tmp/opencode.json",
      OPENCODE_DDG_SEARCH: "true",
      OPENCODE_TAVILY_URL: "https://mcp.tavily.com/mcp/",
    });
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    expect(Object.keys(cfg).filter((k) => k.startsWith("OPENCODE_"))).toEqual([]);
    expect(cfg.REPOS_ROOT).toBe(repoRoot);
  });
});

// --- the migration path ------------------------------------------------------

describe("#12 retired-agent migration", () => {
  it("records opencode as retired with a reason", () => {
    const retired = retiredAgent("opencode");
    expect(retired).toBeDefined();
    expect(retired!.reason).toContain("retired in #12");
    expect(RETIRED_AGENTS.has("opencode")).toBe(true);
  });

  it("says nothing about ids that are merely unknown", () => {
    expect(retiredAgent("not-an-agent")).toBeUndefined();
    expect(retiredAgentMessage("not-an-agent")).toBeNull();
    expect(retiredAgentMessage("claude")).toBeNull();
  });

  it("names the retirement and the fix", () => {
    const msg = retiredAgentMessage("opencode")!;
    expect(msg).toContain("retired");
    expect(msg).toContain("/seam config agent");
    expect(msg).toContain("keeps its history");
  });

  it("fails a persisted opencode session with the retirement message, not a bare unknown-agent error", () => {
    const router = makeRouter();
    const record = makeRecord({ agentId: "opencode" });
    expect(() => router.planRuntimeSpawn(record)).toThrow(/retired/i);
    expect(() => router.planRuntimeSpawn(record)).toThrow(/\/seam config agent/);
    expect(() => router.planRuntimeSpawn(record)).not.toThrow(/Unknown agent profile/);
  });

  it("does NOT silently reroute a retired session to the default agent", () => {
    const router = makeRouter();
    // The default agent is registered and healthy; the retired thread must still
    // refuse rather than quietly run its prompts on claude.
    expect(() => router.planRuntimeSpawn(makeRecord({ agentId: "opencode" }))).toThrow();
    expect(router.planRuntimeSpawn(makeRecord()).profile.id).toBe("claude");
  });

  it("keeps the generic unknown-agent error for a genuine typo", () => {
    const router = makeRouter();
    expect(() => router.planRuntimeSpawn(makeRecord({ agentId: "cluade" }))).toThrow(
      /Unknown agent profile "cluade"/
    );
  });

  it("still resolves a brand key for a retired id so old cards do not crash", () => {
    // describeConfig / status-card rendering runs on records the router refuses
    // to spawn; brand resolution must stay total.
    expect(resolveAgentBrand("opencode")).toBe("opencode");
  });

  it("describeConfig still reports a retired session's stored agent", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord({ agentId: "opencode" }));
    expect(d.agent).toEqual({ value: "opencode", source: "session config" });
  });
});
