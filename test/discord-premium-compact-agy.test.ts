import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import {
  DISCORD_COMPACTION_MODEL,
} from "../packages/core/src/core/compaction/discord-executor.js";
import { PINNED_FACTS_JSON_SCHEMA } from "../packages/core/src/core/compaction/prompts.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const PINNED = JSON.stringify({
  corrections: [],
  constraints: [],
  decisions: [],
  openTodos: [],
  activePaths: [],
  rules: [],
});

const DESTINATIONS = [
  { agentId: "codex", model: "gpt-5.4", effort: "medium" },
  { agentId: "claude", model: "claude-opus-4.8", effort: "high" },
  { agentId: "copilot", model: "gpt-5.5", effort: "high" },
] as const;

function threadMessages(count = 12) {
  return Array.from({ length: count }, (_, i) => ({
    ts: Date.parse("2026-01-01T00:00:00Z") + i * 1000,
    authorIsBot: i % 2 === 1,
    text: `message ${i} ${"content ".repeat(30)}`,
    authorName: i % 2 === 0 ? "jesse" : "bot",
  }));
}

function makePolicyOrch(opts: {
  destId: string;
  destModel: string;
  destEffort: string;
  destCwd?: string;
  agy?: false | { manager?: boolean; models?: string[] };
  agyError?: string;
}) {
  const destMgr = { name: "dest-manager" };
  const agyMgr = { name: "agy-manager" };
  const dest = {
    id: opts.destId,
    displayName: opts.destId,
    sessionManager: destMgr,
  };
  const agyEnabled = opts.agy !== false;
  const agyModels =
    opts.agy && typeof opts.agy === "object" && opts.agy.models
      ? opts.agy.models
      : [DISCORD_COMPACTION_MODEL];
  const agyHasManager = !(opts.agy && typeof opts.agy === "object" && opts.agy.manager === false);
  const agy = agyEnabled
    ? {
        id: "agy",
        displayName: "Antigravity",
        sessionManager: agyHasManager ? agyMgr : undefined,
        listPickerModels: async () => agyModels.map((modelId) => ({ modelId, name: modelId })),
      }
    : undefined;

  const injectCalls: Array<{
    profileId?: string;
    model?: string;
    strictModel?: boolean;
    cwd?: string;
    label?: string;
    prompt?: string;
    jsonSchema?: Record<string, unknown>;
  }> = [];
  const seedCalls: any[] = [];
  const fetches: number[] = [];

  const record: SessionRecord = {
    id: "discord:thread-c",
    platform: "discord",
    channelRef: "thread-c",
    parentRef: null,
    agentId: opts.destId,
    acpSessionId: "acp-active",
    repoPath: opts.destCwd ?? "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  };

  const router = {
    listProfiles: () => (agy ? [dest, agy] : [dest]),
    describeConfig: () => ({}),
    getProfile: (id?: string) => (id === "agy" ? agy : dest),
    invalidate: async () => {},
  };
  const bound = { value: record.acpSessionId };
  const store = {
    readConfig: () => ({ model: opts.destModel, reasoningEffort: opts.destEffort }),
    get: () => ({ ...record, acpSessionId: bound.value }),
    compareAndSwapAcpSession: (_id: string, expected: string, next: string) => {
      const ok = bound.value === expected;
      if (ok) bound.value = next;
      return ok;
    },
    upsert: () => {},
    deleteSession: () => {},
    recordDelegation: () => {},
    updateDelegationStatus: () => {},
  };
  const adapter = {
    fetchThreadMessagesTimed: async () => {
      fetches.push(1);
      return threadMessages();
    },
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: "/tmp/none",
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: {},
      threadPresets: {},
    } as any,
    adapter: adapter as any,
    router: router as any,
    store: store as any,
    renderer: {} as any,
  });

  (orch as any).injectTurn = async (_target: unknown, prompt: string, injectOpts: any) => {
    injectCalls.push({
      profileId: injectOpts.profile?.id,
      model: injectOpts.model,
      strictModel: injectOpts.strictModel,
      cwd: injectOpts.cwd,
      label: injectOpts.logContext?.compaction,
      prompt,
      jsonSchema: injectOpts.jsonSchema,
    });
    if (injectOpts.profile?.id !== "agy") {
      return {
        text: "",
        error: "destination provider must not run Discord premium analysis",
        cause: new Error("destination provider must not run Discord premium analysis"),
      };
    }
    if (opts.agyError) {
      return { text: "", error: opts.agyError, cause: new Error(opts.agyError) };
    }
    const label = String(injectOpts.logContext?.compaction ?? "");
    if (label.startsWith("pinned")) return { text: PINNED };
    return { text: `summary ${label}` };
  };
  (orch as any).seedNewSession = async (args: any) => {
    seedCalls.push(args);
    return "sess-new";
  };

  return { orch, record, injectCalls, seedCalls, fetches, dest, agy };
}

describe("Premium Compact (Discord) AGY executor boundary", () => {
  it.each(DESTINATIONS)(
    "runs every analysis call through AGY + exact model for destination $agentId",
    async (dest) => {
      const t = makePolicyOrch({
        destId: dest.agentId,
        destModel: dest.model,
        destEffort: dest.effort,
      });
      const res = await t.orch.compactThread(t.record, { source: "discord" });

      expect(t.injectCalls.length).toBeGreaterThan(0);
      for (const call of t.injectCalls) {
        expect(call.profileId).toBe("agy");
        expect(call.model).toBe("gemini-3.8-flash-high");
        expect(call.model).not.toBe("default");
        expect(call.strictModel).toBe(true);
        expect(call.cwd).toBe("/tmp");
      }
      expect(t.injectCalls.some((c) => c.label?.startsWith("chunk-"))).toBe(true);
      expect(t.injectCalls.some((c) => c.label?.startsWith("pinned-"))).toBe(true);
      expect(t.injectCalls.every((c) => c.profileId !== dest.agentId)).toBe(true);
      for (const call of t.injectCalls) {
        if (call.label?.startsWith("chunk-")) {
          expect(call.jsonSchema).toBeUndefined();
        }
        if (call.label?.startsWith("pinned-")) {
          expect(call.jsonSchema).toEqual(PINNED_FACTS_JSON_SCHEMA);
        }
      }

      expect(t.seedCalls).toHaveLength(1);
      expect(t.seedCalls[0].profile.id).toBe(dest.agentId);
      expect(t.seedCalls[0].model).toBe(dest.model);
      expect(t.seedCalls[0].effort).toBe(dest.effort);
      expect(t.seedCalls[0].cwd).toBe("/repo");
      expect(res.analysisExecutor).toEqual({
        id: "agy",
        displayName: "AGY",
        model: "gemini-3.8-flash-high",
      });
      expect(res.reportMarkdown).toContain("AGY · gemini-3.8-flash-high");
      expect(res.reportMarkdown).not.toMatch(/using Gemini\./);
    }
  );

  it("fails closed when AGY is missing and never calls the destination", async () => {
    const t = makePolicyOrch({
      destId: "codex",
      destModel: "gpt-5.4",
      destEffort: "medium",
      agy: false,
    });
    await expect(t.orch.compactThread(t.record, { source: "discord" })).rejects.toThrow(
      /AGY profile/
    );
    expect(t.injectCalls).toHaveLength(0);
    expect(t.seedCalls).toHaveLength(0);
    expect(t.fetches).toHaveLength(0);
  });

  it("fails closed when the AGY manager is missing", async () => {
    const t = makePolicyOrch({
      destId: "claude",
      destModel: "claude-opus-4.8",
      destEffort: "high",
      agy: { manager: false },
    });
    await expect(t.orch.compactThread(t.record, { source: "discord" })).rejects.toThrow(
      /session manager/
    );
    expect(t.injectCalls).toHaveLength(0);
    expect(t.seedCalls).toHaveLength(0);
  });

  it("fails closed when the exact model is absent from the live catalog", async () => {
    const t = makePolicyOrch({
      destId: "copilot",
      destModel: "gpt-5.5",
      destEffort: "high",
      agy: { models: ["gemini-3.7-flash-high", "default"] },
    });
    await expect(t.orch.compactThread(t.record, { source: "discord" })).rejects.toThrow(
      /gemini-3\.8-flash-high/
    );
    expect(t.injectCalls).toHaveLength(0);
    expect(t.seedCalls).toHaveLength(0);
    expect(t.fetches).toHaveLength(0);
  });

  it("does not fall back to the destination when a pinned stage omits structured output", async () => {
    const t = makePolicyOrch({
      destId: "codex",
      destModel: "gpt-5.4",
      destEffort: "medium",
    });
    const orig = (t.orch as any).injectTurn;
    (t.orch as any).injectTurn = async (_target: unknown, prompt: string, injectOpts: any) => {
      const result = await orig(_target, prompt, injectOpts);
      if (String(injectOpts.logContext?.compaction ?? "").startsWith("pinned")) {
        expect(injectOpts.jsonSchema).toEqual(PINNED_FACTS_JSON_SCHEMA);
      }
      return result;
    };
    await t.orch.compactThread(t.record, { source: "discord" });
    expect(t.injectCalls.every((c) => c.profileId === "agy")).toBe(true);
    expect(t.seedCalls[0].profile.id).toBe("codex");
  });

  it("fails closed on an AGY analysis error and does not seed or fall back", async () => {
    const t = makePolicyOrch({
      destId: "codex",
      destModel: "gpt-5.4",
      destEffort: "medium",
      agyError: "agy rejected gemini-3.8-flash-high",
    });
    await expect(t.orch.compactThread(t.record, { source: "discord" })).rejects.toThrow(
      /agy\/gemini-3\.8-flash-high/
    );
    expect(t.injectCalls.length).toBeGreaterThan(0);
    expect(t.injectCalls.every((c) => c.profileId === "agy")).toBe(true);
    expect(t.seedCalls).toHaveLength(0);
  });
});
