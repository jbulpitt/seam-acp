/**
 * #474 — host-scoped agent availability.
 *
 * `COPILOT_ENABLED=false` removed the profile everywhere, including the 14
 * FHR threads on `fhr-server`. A deny list withholds `copilot@local` while
 * the profile stays registered so `copilot@fhr-server` still resolves.
 *
 * #468 (bridge, Opus) refuses a stated agentId the host does not hold.
 * This is the adjacent controller question: a known agent, a denied
 * location. Same answer — refuse, name it, never substitute.
 *
 * The mutation this story exists to kill: a deny list that filters the
 * picker but still permits the router to ask the local bridge to spawn.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import {
  DeniedAgentLocationError,
  assertAgentLocationAllowed,
  deniedAgentLocationMessage,
  getAgentLocationDeny,
  installAgentLocationDeny,
  isAgentLocationDenied,
  listAgentLocationChoices,
  listHosts,
  parseAgentLocationDeny,
  setAgentLocationDeny,
} from "../packages/core/src/core/location.js";
import { agentLocationPickerChoices } from "../packages/core/src/platforms/discord/location.js";
import { loadConfig } from "../packages/core/src/config.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ThreadPreset } from "../packages/core/src/config.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_PRESETS = "/home/ubuntu/Projects/seam-acp/data/channel-presets.json";

/** Measured 2026-09-20: 15 explicit copilot thread presets, 14 on fhr-server. */
const FHR_COPILOT_THREADS = [
  "1538909622981627996",
  "1541667810021875843",
  "1544403629841322024",
  "1541579247645102202",
  "1544403627886649374",
  "1544349405317038080",
  "1541664456059129926",
  "1525144372801306665",
  "1496216001203798188",
  "1498394632382451853",
  "1496212130112733375",
  "1516913670267994313",
  "1519304338072145970",
  "1519304621523337427",
] as const;
const LOCAL_COPILOT_THREAD = "1516911271272779776";

function stubProfile(id: string, spawnCalls: unknown[] = []): AgentProfile {
  return {
    id,
    displayName: id,
    defaultModel: id,
    spawn(model?: string, effort?: string, mcpServers = []) {
      spawnCalls.push({ model, effort, mcpServers });
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
    needsAgyIdentityRebuild: () => false,
    lookupAgentChannelRestriction: () => ({ state: "absent" as const }),
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
    agentId: "copilot",
    acpSessionId: "",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "gpt-5.4" } satisfies SessionConfigState),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

afterEach(() => {
  setAgentLocationDeny([]);
});

describe("#474 parseAgentLocationDeny", () => {
  it("empty is opt-out", () => {
    expect(parseAgentLocationDeny("")).toEqual([]);
    expect(parseAgentLocationDeny("   ")).toEqual([]);
  });

  it("parses explicit agentId@location pairs", () => {
    expect(parseAgentLocationDeny("copilot@local")).toEqual([
      { agentId: "copilot", location: "local" },
    ]);
    expect(parseAgentLocationDeny("copilot@local,ollama-cloud@fhr-server")).toEqual([
      { agentId: "copilot", location: "local" },
      { agentId: "ollama-cloud", location: "fhr-server" },
    ]);
  });

  it("refuses a bare id — that is a global ban, not this list", () => {
    expect(() => parseAgentLocationDeny("copilot")).toThrow(/agentId@location/);
    expect(() => parseAgentLocationDeny("copilot")).toThrow(/COPILOT_ENABLED=false/);
  });

  it("does not silently substitute local for a missing location", () => {
    expect(() => parseAgentLocationDeny("copilot@")).toThrow(/agentId@location/);
  });
});

describe("#474 picker omits the denied pair and keeps the rest", () => {
  const deny = parseAgentLocationDeny("copilot@local");
  const hosts = listHosts({
    bridges: [{ id: "fhr-server", tokenHash: "a".repeat(64), shortName: "fhr-server" }],
    connected: new Set(["local", "fhr-server"]),
  });
  const profiles = [
    { id: "claude", displayName: "Claude" },
    { id: "copilot", displayName: "Copilot" },
  ];

  it("does not offer copilot@local", () => {
    const choices = listAgentLocationChoices({
      profiles,
      hosts,
      agentsByHost: new Map([
        ["local", new Set(["claude", "copilot"])],
        ["fhr-server", new Set(["copilot", "agy"])],
      ]),
      deny,
    });
    expect(choices.map((c) => c.value)).not.toContain("copilot@local");
    expect(choices.map((c) => c.value)).toContain("copilot@fhr-server");
    expect(choices.map((c) => c.value)).toContain("claude@local");
  });

  it("installed deny reaches the orchestrator picker wrapper without an extra arg", () => {
    setAgentLocationDeny(deny);
    const choices = agentLocationPickerChoices(profiles, {
      bridges: [{ id: "fhr-server", tokenHash: "a".repeat(64), shortName: "fhr-server" }],
      connected: new Set(["local", "fhr-server"]),
      agentsByHost: new Map([
        ["local", new Set(["claude", "copilot"])],
        ["fhr-server", new Set(["copilot"])],
      ]),
    });
    expect(choices.map((c) => c.value)).not.toContain("copilot@local");
    expect(choices.map((c) => c.value)).toContain("copilot@fhr-server");
    expect(getAgentLocationDeny()).toEqual(deny);
  });
});

describe("#474 bridge-plan refusal — independent of the picker", () => {
  const deny = parseAgentLocationDeny("copilot@local");

  it("assertAgentLocationAllowed is the spawn gate, not a picker helper", () => {
    expect(() => assertAgentLocationAllowed("copilot", "local", deny)).toThrow(
      DeniedAgentLocationError,
    );
    expect(() => assertAgentLocationAllowed("copilot", "fhr-server", deny)).not.toThrow();
    expect(isAgentLocationDenied("copilot", "fhr-server", deny)).toBe(false);
  });
});

describe("#474 SessionRouter: copilot@fhr-server still plans; copilot@local does not", () => {
  const deny = parseAgentLocationDeny("copilot@local");

  function makeRouter(threadPresets: Map<string, ThreadPreset>, spawnCalls: unknown[]) {
    const copilot = stubProfile("copilot", spawnCalls);
    const claude = stubProfile("claude", []);
    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [copilot, claude],
      modelCatalog: fixtureModelCatalog([copilot, claude]),
      defaultAgentId: "claude",
      defaultModel: "opus",
      threadPresets,
      seamMcp: {
        registry: { mint: () => "token", peek: () => "token" } as never,
        getPort: () => undefined,
        isBridgeSession: () => true,
        muxForSession: () => ({ spawn() {}, rpc: async () => ({}), releaseStdin() {} }) as never,
      },
    });
    installAgentLocationDeny(router, deny);
    return router;
  }

  it("getProfile withholds local and still returns the registered profile for fhr-server", () => {
    const router = makeRouter(new Map(), []);
    expect(router.getProfile("copilot", "local")).toBeUndefined();
    expect(router.getProfile("copilot", "fhr-server")?.id).toBe("copilot");
    expect(router.getProfile("claude", "local")?.id).toBe("claude");
    expect(router.listProfiles().map((p) => p.id)).toEqual(["copilot", "claude"]);
  });

  it("planRuntimeSpawn refuses a local copilot session with the deny copy, not Unknown agent", () => {
    const router = makeRouter(new Map(), []);
    expect(() => router.planRuntimeSpawn(makeRecord({ channelRef: LOCAL_COPILOT_THREAD }))).toThrow(
      /AGENT_LOCATION_DENY/,
    );
    expect(() => router.planRuntimeSpawn(makeRecord({ channelRef: LOCAL_COPILOT_THREAD }))).toThrow(
      /copilot/,
    );
    expect(() => router.planRuntimeSpawn(makeRecord({ channelRef: LOCAL_COPILOT_THREAD }))).not.toThrow(
      /Unknown agent profile/,
    );
  });

  it("planRuntimeSpawn still resolves copilot for an fhr-server thread", () => {
    const threadPresets = new Map<string, ThreadPreset>([
      [FHR_COPILOT_THREADS[0], { agent: { value: "copilot" }, location: "fhr-server" }],
    ]);
    const router = makeRouter(threadPresets, []);
    const plan = router.planRuntimeSpawn(
      makeRecord({ channelRef: FHR_COPILOT_THREADS[0], agentId: "copilot" }),
    );
    expect(plan.agentId).toBe("copilot");
    expect(plan.location).toBe("fhr-server");
    expect(plan.profile.id).toBe("copilot");
  });

  it("all 14 measured fhr-server copilot presets still resolve", () => {
    const threadPresets = new Map<string, ThreadPreset>(
      FHR_COPILOT_THREADS.map((id) => [id, { agent: { value: "copilot" }, location: "fhr-server" }]),
    );
    const router = makeRouter(threadPresets, []);
    const resolved: string[] = [];
    const refused: string[] = [];
    for (const id of FHR_COPILOT_THREADS) {
      try {
        const plan = router.planRuntimeSpawn(makeRecord({ channelRef: id, agentId: "copilot" }));
        if (plan.agentId === "copilot" && plan.location === "fhr-server") resolved.push(id);
      } catch {
        refused.push(id);
      }
    }
    expect(resolved).toHaveLength(14);
    expect(refused).toEqual([]);
  });

});

describe("#474 DEFAULT_AGENT denied at local refuses boot", () => {
  let env: Record<string, string | undefined>;

  function baseEnv(extra: Record<string, string | undefined>) {
    env = {
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: repoRoot,
      ...extra,
    };
  }

  it("refuses DEFAULT_AGENT=copilot when copilot@local is denied", () => {
    baseEnv({ DEFAULT_AGENT: "copilot", AGENT_LOCATION_DENY: "copilot@local" });
    expect(() => loadConfig({ env })).toThrow(/AGENT_LOCATION_DENY/);
    expect(() => loadConfig({ env })).toThrow(/will not substitute one for you/);
    expect(() => loadConfig({ env })).not.toThrow(/\/seam config agent/);
  });

  it("accepts DEFAULT_AGENT=claude with copilot@local denied", () => {
    baseEnv({ DEFAULT_AGENT: "claude", AGENT_LOCATION_DENY: "copilot@local" });
    const cfg = loadConfig({ env });
    expect(cfg.DEFAULT_AGENT).toBe("claude");
    expect(cfg.AGENT_LOCATION_DENY).toEqual([{ agentId: "copilot", location: "local" }]);
  });
});

describe("#474 prove the outcome against real channel-presets.json", () => {
  const deny = parseAgentLocationDeny("copilot@local");

  it.skipIf(!fs.existsSync(MAIN_PRESETS))(
    "live file: 14 fhr-server copilot presets stay allowed; local copilot is denied",
    () => {
    const data = JSON.parse(fs.readFileSync(MAIN_PRESETS, "utf8")) as {
      threads?: Record<string, { agent?: { value?: string }; location?: string }>;
    };
    const threads = data.threads ?? {};
    const explicitCopilot = Object.entries(threads).filter(
      ([, t]) => t.agent?.value === "copilot",
    );
    const fhr = explicitCopilot.filter(([, t]) => t.location === "fhr-server");
    const local = explicitCopilot.filter(([, t]) => !t.location || t.location === "local");
    expect(fhr.length, "fhr-server copilot presets").toBe(14);
    expect(local.length, "local copilot presets").toBe(1);
    for (const [, t] of fhr) {
      expect(isAgentLocationDenied("copilot", t.location, deny)).toBe(false);
    }
    for (const [, t] of local) {
      expect(isAgentLocationDenied("copilot", t.location ?? "local", deny)).toBe(true);
    }
    expect(explicitCopilot.map(([id]) => id).sort()).toEqual(
      [...FHR_COPILOT_THREADS, LOCAL_COPILOT_THREAD].slice().sort(),
    );
  });
});

describe("#474 wiring is not decoration — index.ts actually installs the gates", () => {
  it("index.ts registers the deny list and installs the router gate", () => {
    const src = fs.readFileSync(path.join(repoRoot, "packages/core/src/index.ts"), "utf8");
    expect(src).toContain("setAgentLocationDeny(config.AGENT_LOCATION_DENY)");
    expect(src).not.toContain("guardLocalProfileSpawn");
    expect(src).toContain("installAgentLocationDeny(router, config.AGENT_LOCATION_DENY)");
  });

  it("the router wrapper still contains the execution-boundary assert", () => {
    const src = fs.readFileSync(path.join(repoRoot, "packages/core/src/core/location.ts"), "utf8");
    expect(src).toMatch(/router\.planRuntimeSpawn = \(record\)[\s\S]*assertAgentLocationAllowed\(plan\.agentId, plan\.location/);
  });

  it("denied copy names the setting and does not substitute", () => {
    const session = deniedAgentLocationMessage("copilot", "local", "session");
    expect(session).toContain("AGENT_LOCATION_DENY");
    expect(session).toContain("/seam config agent");
    expect(session).not.toMatch(/will run as claude/i);
  });
});
