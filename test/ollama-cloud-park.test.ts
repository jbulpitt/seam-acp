/**
 * #220 — park ollama-cloud (disable, do not delete).
 *
 * Contrast #12 (opencode deletion): the profile factory, env schema, brand,
 * namer glyph, tests, and `~/.codex-ollama-cloud` layout stay. `OLLAMA_CLOUD_ENABLED`
 * is the complete reversible switch for catalog, quota, provider-status, and
 * leftover sessions.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import * as adapters from "@seam/adapters";
import { makeCodexProfile } from "@seam/adapters";

const { fetchOllamaCloudUsageMock } = vi.hoisted(() => ({
  fetchOllamaCloudUsageMock: vi.fn(async () => ({
    ok: false as const,
    fiveHour: null,
    weekly: null,
    error: "ollama-usage spawn failed: mocked",
  })),
}));

vi.mock("@seam/adapters", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@seam/adapters")>();
  return { ...orig, fetchOllamaCloudUsage: fetchOllamaCloudUsageMock };
});
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import {
  LINKWORKS_OLLAMA_SOURCE_ID,
  OLLAMA_CLOUD_AGENT_ID,
  OLLAMA_CLOUD_ENABLE_FLAG,
  PARKED_OLLAMA_CLOUD_SELECT_MESSAGE,
  PARKED_OLLAMA_CLOUD_SESSION_MESSAGE,
  formatUsageAgentList,
  isOllamaCloudAgentId,
  liveUsageAgentLabels,
  parkedAgentMessage,
  shouldIncludeLinkworksOllamaSource,
  shouldRegisterOllamaCloud,
} from "../packages/core/src/core/parked-agents.js";
import { createAgentQuotaSources } from "../packages/core/src/core/quota/quota-poller.js";
import { createDefaultServiceStatusSources } from "../packages/core/src/core/service-status/sources/registry.js";
import { loadConfig } from "../packages/core/src/config.js";
import { DEFAULT_THREAD_NAMER_CONFIG } from "../packages/core/src/platforms/discord/thread-namer.js";
import { agentLocationPickerChoices } from "../packages/core/src/platforms/discord/location.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { ThreadSessionControlService } from "../packages/core/src/core/thread-session-control.js";
import { resolveAgentBrand, loadBrandAsset } from "../packages/core/src/core/agent-brand.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";

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

function makeRouter(opts: {
  profiles?: AgentProfile[];
  ollamaCloudEnabled?: boolean;
} = {}): SessionRouter {
  return new SessionRouter({
    logger: silent,
    store: stubStore(),
    profiles: opts.profiles ?? [stubProfile("claude")],
    defaultAgentId: "claude",
    defaultModel: "opus",
    threadPresets: new Map(),
    ollamaCloudEnabled: opts.ollamaCloudEnabled,
  });
}

describe("#220 ollama-cloud is parked, not deleted", () => {
  it("keeps the profile module, factory export, brand asset, and namer glyph", () => {
    expect(
      fs.existsSync(path.join(repoRoot, "packages/adapters/src/profiles/ollama-cloud.ts"))
    ).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "assets/agents/ollama-cloud.webp"))).toBe(true);
    expect(typeof adapters.fetchOllamaCloudUsage).toBe("function");
    expect(loadBrandAsset("ollama-cloud")).not.toBeNull();
    expect(resolveAgentBrand("ollama-cloud")).toBe("ollama-cloud");
    expect(DEFAULT_THREAD_NAMER_CONFIG.agents.map((a) => a.match)).toContain("ollama");
    expect(
      DEFAULT_THREAD_NAMER_CONFIG.agents.find((a) => a.match === "ollama")?.replacement
    ).toBe("🦙");
  });

  it("keeps OLLAMA_CLOUD_* keys in the parsed config schema", () => {
    const saved = { ...process.env };
    process.env = {
      ...saved,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: repoRoot,
      CHANNEL_PRESETS_FILE: undefined,
      OLLAMA_CLOUD_ENABLED: "false",
    } as NodeJS.ProcessEnv;
    try {
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      expect(cfg.OLLAMA_CLOUD_ENABLED).toBe(false);
      expect("OLLAMA_CLOUD_API_KEY" in cfg).toBe(true);
      expect("OLLAMA_CLOUD_DEFAULT_MODEL" in cfg).toBe(true);
      expect("OLLAMA_USAGE_CLI_PATH" in cfg).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});

describe("#220 registration gate", () => {
  it("does not register when the flag is off, even with a dummy key", () => {
    expect(
      shouldRegisterOllamaCloud({
        OLLAMA_CLOUD_ENABLED: false,
        OLLAMA_CLOUD_API_KEY: "dummy-test-key",
      })
    ).toBe(false);
  });

  it("registers when the flag is on with a dummy key", () => {
    expect(
      shouldRegisterOllamaCloud({
        OLLAMA_CLOUD_ENABLED: true,
        OLLAMA_CLOUD_API_KEY: "dummy-test-key",
      })
    ).toBe(true);
    const profile = makeCodexProfile({
      id: OLLAMA_CLOUD_AGENT_ID,
      displayName: "Ollama Cloud",
      defaultModel: "glm-5.3:cloud",
      extraEnv: { OLLAMA_CLOUD_API_KEY: "dummy-test-key" },
    });
    expect(profile.id).toBe(OLLAMA_CLOUD_AGENT_ID);
  });

  it("does not register when the flag is on but the key is missing", () => {
    expect(
      shouldRegisterOllamaCloud({ OLLAMA_CLOUD_ENABLED: true, OLLAMA_CLOUD_API_KEY: "" })
    ).toBe(false);
    expect(shouldRegisterOllamaCloud({ OLLAMA_CLOUD_ENABLED: true })).toBe(false);
  });

  it("does not advertise ollama-cloud or the Linkworks probe as always-on live surfaces", () => {
    const mcp = fs.readFileSync(
      path.join(repoRoot, "packages/core/src/core/mcp/seam-mcp-server.ts"),
      "utf8"
    );
    expect(mcp).not.toMatch(/third-party Ollama probe/);
    const indexSrc = fs.readFileSync(path.join(repoRoot, "packages/core/src/index.ts"), "utf8");
    expect(indexSrc).toContain("shouldIncludeLinkworksOllamaSource");
    expect(indexSrc).toContain("ollamaCloudEnabled: config.OLLAMA_CLOUD_ENABLED");
  });

  it("production boot constructs ollama-cloud only via shouldRegisterOllamaCloud", () => {
    const src = fs.readFileSync(path.join(repoRoot, "packages/core/src/index.ts"), "utf8");
    expect(src).toContain("shouldRegisterOllamaCloud(config)");
    const start = src.indexOf("Optional Ollama Cloud agent");
    const end = src.indexOf("Agent-facing seam-MCP surface");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('id: "ollama-cloud"');
    expect(block).toContain("makeCodexProfile");
    expect(block).toContain("ollamaCloudLive");
    expect(block).not.toMatch(/OLLAMA_CLOUD_ENABLED && config\.OLLAMA_CLOUD_API_KEY/);
  });

  it("flag off: live catalog and picker cannot select ollama-cloud", () => {
    const live = shouldRegisterOllamaCloud({
      OLLAMA_CLOUD_ENABLED: false,
      OLLAMA_CLOUD_API_KEY: "dummy-test-key",
    });
    const profiles = live
      ? [stubProfile("claude"), stubProfile(OLLAMA_CLOUD_AGENT_ID)]
      : [stubProfile("claude")];
    const router = makeRouter({ profiles, ollamaCloudEnabled: false });
    expect(router.listProfiles().map((p) => p.id)).not.toContain(OLLAMA_CLOUD_AGENT_ID);
    expect(router.getProfile(OLLAMA_CLOUD_AGENT_ID)).toBeUndefined();
    const choices = agentLocationPickerChoices(router.listProfiles(), { bridges: [] });
    expect(choices.some((c) => c.value.includes(OLLAMA_CLOUD_AGENT_ID))).toBe(false);
    expect(choices.some((c) => c.value.includes("claude"))).toBe(true);
  });

  it("flag on with a dummy key: profile is in the live catalog and picker", () => {
    const live = shouldRegisterOllamaCloud({
      OLLAMA_CLOUD_ENABLED: true,
      OLLAMA_CLOUD_API_KEY: "dummy-test-key",
    });
    expect(live).toBe(true);
    const profiles = [stubProfile("claude"), stubProfile(OLLAMA_CLOUD_AGENT_ID)];
    const router = makeRouter({ profiles, ollamaCloudEnabled: true });
    expect(router.listProfiles().map((p) => p.id)).toContain(OLLAMA_CLOUD_AGENT_ID);
    const choices = agentLocationPickerChoices(router.listProfiles(), { bridges: [] });
    expect(choices.some((c) => c.value.includes(`${OLLAMA_CLOUD_AGENT_ID}@local`))).toBe(true);
  });

  it("negative control: a live catalog must not include ollama-cloud while the flag is off", () => {
    const catalog = (enabled: boolean, key?: string) => {
      const ids = ["claude", "copilot"];
      if (shouldRegisterOllamaCloud({ OLLAMA_CLOUD_ENABLED: enabled, OLLAMA_CLOUD_API_KEY: key })) {
        ids.push(OLLAMA_CLOUD_AGENT_ID);
      }
      return ids;
    };
    expect(catalog(false, "dummy-test-key")).not.toContain(OLLAMA_CLOUD_AGENT_ID);
    expect(catalog(true, "dummy-test-key")).toContain(OLLAMA_CLOUD_AGENT_ID);
    expect(catalog(true)).not.toContain(OLLAMA_CLOUD_AGENT_ID);
  });
});

describe("#220 leftover sessions fail closed", () => {
  it("uses the parked session message, not #12 retirement wording", () => {
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).toContain(OLLAMA_CLOUD_AGENT_ID);
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).toContain(OLLAMA_CLOUD_ENABLE_FLAG);
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).toMatch(/parked/i);
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).toContain("not retired");
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).not.toMatch(/is retired:/);
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).not.toContain("retired in #12");
    expect(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE).not.toContain("the surface was unused");
    expect(parkedAgentMessage("ollama-cloud", false, "session")).toBe(
      PARKED_OLLAMA_CLOUD_SESSION_MESSAGE
    );
  });

  it("fails a persisted ollama-cloud session with the parked message, not unknown-agent or substitution", () => {
    const router = makeRouter({
      profiles: [stubProfile("claude")],
      ollamaCloudEnabled: false,
    });
    const record = makeRecord({ agentId: OLLAMA_CLOUD_AGENT_ID });
    expect(() => router.planRuntimeSpawn(record)).toThrow(PARKED_OLLAMA_CLOUD_SESSION_MESSAGE);
    expect(() => router.planRuntimeSpawn(record)).not.toThrow(/Unknown agent profile/);
    expect(() => router.planRuntimeSpawn(record)).not.toThrow(/is retired:/);
    expect(router.planRuntimeSpawn(makeRecord()).profile.id).toBe("claude");
  });

  it("does NOT silently reroute a parked session to the default agent", () => {
    const router = makeRouter({ ollamaCloudEnabled: false });
    expect(() => router.planRuntimeSpawn(makeRecord({ agentId: OLLAMA_CLOUD_AGENT_ID }))).toThrow();
    expect(router.planRuntimeSpawn(makeRecord()).profile.id).toBe("claude");
  });

  it("keeps the generic unknown-agent error for a genuine typo", () => {
    const router = makeRouter({ ollamaCloudEnabled: false });
    expect(() => router.planRuntimeSpawn(makeRecord({ agentId: "cluade" }))).toThrow(
      /Unknown agent profile "cluade"/
    );
  });

  it("describeConfig still reports a parked session's stored agent", () => {
    const router = makeRouter({ ollamaCloudEnabled: false });
    const d = router.describeConfig(makeRecord({ agentId: OLLAMA_CLOUD_AGENT_ID }));
    expect(d.agent).toEqual({ value: OLLAMA_CLOUD_AGENT_ID, source: "session config" });
  });
});

describe("#220 picker / configure refuse parked ollama-cloud", () => {
  it("configure_thread cannot select ollama-cloud while parked", async () => {
    const target = makeRecord();
    const caller = makeRecord({ id: "discord:caller", channelRef: "caller" });
    const profiles = new Map([["claude", stubProfile("claude")]]);
    const router = makeRouter({ profiles: [...profiles.values()], ollamaCloudEnabled: false });
    const service = new ThreadSessionControlService({
      store: {
        get: (id) => (id === target.id ? target : id === caller.id ? caller : null),
        readConfig: () => ({}),
        writeConfig: (cfg) => JSON.stringify(cfg),
        upsert: () => {},
      },
      router: {
        describeConfig: (record) =>
          ({
            agent: { value: record.agentId, source: "session config" },
            model: { value: "opus", source: "session config" },
            effort: { value: null, source: "default" },
            role: { value: null, source: "default" },
            disableThreadPrefix: { value: false, source: "default" },
          }) as ConfigDescription,
        getProfile: (id) => profiles.get(id),
        parkedSelectMessage: (id) => router.parkedSelectMessage(id),
        unregisteredAgentMessage: (id, fallback) => router.unregisteredAgentMessage(id, fallback),
        getOrStartRuntime: async () => {
          throw new Error("should not start");
        },
        invalidate: async () => {},
      },
      mutation: {
        applySessionConfig: () => ({ ok: false, error: "unused" }),
        applyThreadOverlay: () => ({ ok: false, error: "unused" }),
      },
    });
    const result = await service.configure(caller, target, { agent: OLLAMA_CLOUD_AGENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(PARKED_OLLAMA_CLOUD_SELECT_MESSAGE);
    expect(result.error).not.toMatch(/is retired:/);
  });

  it("config mutation cannot select ollama-cloud while parked, even if a stale profile is present", () => {
    const profiles = new Map<string, AgentProfile>([
      ["claude", stubProfile("claude")],
      [OLLAMA_CLOUD_AGENT_ID, stubProfile(OLLAMA_CLOUD_AGENT_ID)],
    ]);
    const svc = new ConfigMutationService({
      store: {
        readConfig: () => ({}),
        writeConfig: (cfg) => JSON.stringify(cfg),
        upsert: () => {},
        getPresetByNameScoped: () => null,
        upsertPreset: () => {},
        deletePreset: () => {},
        recordConfigMutation: () => ({ id: "audit" }) as never,
        getScheduled: () => null,
        listScheduledByChannel: () => [],
        upsertScheduled: () => {},
        deleteScheduled: () => {},
      },
      describeConfig: (record) =>
        ({
          sessionId: record.id,
          channelRef: record.channelRef,
          parentRef: record.parentRef,
          agent: { value: record.agentId, source: "session config" },
          model: { value: "opus", source: "session config" },
          effort: { value: null, source: "default" },
          role: { value: null, source: "default" },
          cwd: { value: "/repo", source: "session config" },
          permission: { value: "ask", source: "default" },
          locked: false,
          detached: { value: false, source: "default" },
          tts: { value: false, source: "default" },
          ttsVoice: { value: null, source: "default" },
          ttsPace: { value: "natural", source: "default" },
          ttsStyle: { value: "neutral", source: "default" },
          location: { value: "local", source: "default" },
          statusCardStyle: { value: "full", source: "default" },
          simpleCardGif: { value: false, source: "default" },
          fastMode: { value: false, source: "default" },
        }) as ConfigDescription,
      profiles,
      defaultModel: "opus",
      presetsFile: undefined,
      tierCEnabled: false,
      reloadPresets: () => ({ ok: true }),
      reschedule: () => {},
      defaultTimezone: "America/Chicago",
      logger: silent,
      ollamaCloudEnabled: false,
    });
    const built = svc.buildProposal(makeRecord(), { session: { agent: OLLAMA_CLOUD_AGENT_ID } });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toBe(PARKED_OLLAMA_CLOUD_SELECT_MESSAGE);
  });
});

describe("#220 usage / quota-poller does not spawn ollama-usage while parked", () => {
  it("omits ollama-cloud from quota sources when the catalog does not include it", () => {
    const sources = createAgentQuotaSources(
      [stubProfile("claude"), stubProfile("codex")],
      { ollamaUsageCliPath: "ollama-usage", ollamaCloudEnabled: false }
    );
    expect(sources.map((s) => s.agentId)).toEqual(["claude", "codex"]);
    expect(sources.map((s) => s.agentId)).not.toContain(OLLAMA_CLOUD_AGENT_ID);
  });

  it("negative control: a stale ollama-cloud profile still does not poll while the flag is off", async () => {
    fetchOllamaCloudUsageMock.mockClear();
    const sources = createAgentQuotaSources([stubProfile(OLLAMA_CLOUD_AGENT_ID)], {
      ollamaUsageCliPath: "ollama-usage",
      ollamaCloudEnabled: false,
    });
    expect(sources).toEqual([]);
    expect(fetchOllamaCloudUsageMock).not.toHaveBeenCalled();
  });

  it("flag on: an ollama-cloud profile is wired to ollama-usage", async () => {
    fetchOllamaCloudUsageMock.mockClear();
    const sources = createAgentQuotaSources([stubProfile(OLLAMA_CLOUD_AGENT_ID)], {
      ollamaUsageCliPath: "/definitely/missing/ollama-usage",
      ollamaCloudEnabled: true,
    });
    expect(sources).toHaveLength(1);
    const quota = await sources[0]!.fetch();
    expect(fetchOllamaCloudUsageMock).toHaveBeenCalledTimes(1);
    expect(quota.ok).toBe(false);
    expect(quota.error).toMatch(/ollama-usage spawn failed/);
  });

  it("usage copy does not advertise ollama-cloud while it is absent from the live catalog", () => {
    const off = liveUsageAgentLabels(["claude", "copilot", "agy", "grok", "codex"]);
    expect(off).not.toContain(OLLAMA_CLOUD_AGENT_ID);
    expect(formatUsageAgentList(off)).not.toContain("ollama-cloud");
    const on = liveUsageAgentLabels(["claude", OLLAMA_CLOUD_AGENT_ID]);
    expect(on).toContain(OLLAMA_CLOUD_AGENT_ID);
  });
});

describe("#220 linkworks-ollama is gated on the same flag", () => {
  it("classifies Linkworks as an ollama-cloud-coupled probe, not independent infra", () => {
    expect(shouldIncludeLinkworksOllamaSource(false)).toBe(false);
    expect(shouldIncludeLinkworksOllamaSource(true)).toBe(true);
    expect(isOllamaCloudAgentId(OLLAMA_CLOUD_AGENT_ID)).toBe(true);
  });

  it("default service_status set omits linkworks-ollama", () => {
    const sources = createDefaultServiceStatusSources();
    expect(sources.map((s) => s.id)).toEqual([
      "github",
      "anthropic",
      "openai",
      "xai",
      "google-ai-studio",
      "google-cloud",
    ]);
    expect(sources.map((s) => s.id)).not.toContain(LINKWORKS_OLLAMA_SOURCE_ID);
  });

  it("flag on restores the Linkworks source", () => {
    const sources = createDefaultServiceStatusSources({ includeLinkworksOllama: true });
    expect(sources.map((s) => s.id)).toContain(LINKWORKS_OLLAMA_SOURCE_ID);
    const probe = sources.find((s) => s.id === LINKWORKS_OLLAMA_SOURCE_ID)!;
    expect(probe.provenance).toBe("external_synthetic");
    expect(probe.scopeNote).toMatch(/NOT official Ollama Cloud status/);
  });
});

describe("#220 DEFAULT_AGENT while parked", () => {
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

  it("refuses to boot when DEFAULT_AGENT names parked ollama-cloud", () => {
    baseEnv({ DEFAULT_AGENT: OLLAMA_CLOUD_AGENT_ID, OLLAMA_CLOUD_ENABLED: "false" });
    expect(() => loadConfig()).toThrow(/DEFAULT_AGENT="ollama-cloud"/);
    expect(() => loadConfig()).toThrow(/parked/);
    expect(() => loadConfig()).toThrow(OLLAMA_CLOUD_ENABLE_FLAG);
    expect(() => loadConfig()).not.toThrow(/is retired:/);
  });
});
