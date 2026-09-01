import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import {
  detectSessionReset,
  type SessionConfigChanges,
} from "../packages/core/src/core/config-mutation.js";
import {
  ThreadSessionControlService,
  type SessionControlRuntime,
  type ThreadSessionControlDeps,
} from "../packages/core/src/core/thread-session-control.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { SessionConfigState, SessionRecord } from "../packages/core/src/core/types.js";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:target",
    platform: "discord",
    channelRef: "target",
    parentRef: "channel",
    agentId: "claude",
    acpSessionId: "session-old",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "claude-old", reasoningEffort: "low" }),
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function profile(id: string, defaultModel: string, models: string[]): AgentProfile {
  return {
    id,
    defaultModel,
    staticModels: models.map((modelId) => ({ modelId, name: modelId })),
  } as AgentProfile;
}

function description(value: SessionRecord, defaults: Map<string, string>): ConfigDescription {
  const cfg = JSON.parse(value.configJson || "{}") as SessionConfigState;
  return {
    sessionId: value.id,
    channelRef: value.channelRef,
    parentRef: value.parentRef,
    agent: { value: value.agentId, source: "session config" },
    model: {
      value: cfg.model ?? defaults.get(value.agentId) ?? "unknown",
      source: cfg.model ? "session config" : "default",
    },
    effort: { value: cfg.reasoningEffort ?? null, source: "session config" },
  } as ConfigDescription;
}

function makeRuntime(
  sessionId: string,
  models: string[],
  effortValues: string[]
): SessionControlRuntime & {
  modelCalls: string[];
  optionCalls: Array<[string, string | boolean]>;
} {
  const modelCalls: string[] = [];
  const optionCalls: Array<[string, string | boolean]> = [];
  return {
    modelCalls,
    optionCalls,
    getSessionInfo: () => ({
      sessionId,
      availableModels: models.map((modelId) => ({ modelId })),
    }),
    getConfigSelectValues: (id) => id === "reasoning_effort" ? effortValues : [],
    setModel: async (modelId) => { modelCalls.push(modelId); },
    setConfigOption: async (id, value) => { optionCalls.push([id, value]); },
  };
}

function harness(opts: {
  target?: SessionRecord;
  efforts?: string[];
  profiles?: AgentProfile[];
} = {}) {
  const target = opts.target ?? record();
  const caller = record({ id: "discord:caller", channelRef: "caller", acpSessionId: "caller-acp" });
  const profiles = opts.profiles ?? [
    profile("claude", "claude-old", ["claude-old", "claude-new"]),
    profile("codex", "gpt-old", ["gpt-old", "gpt-new"]),
    profile("ollama-cloud", "qwen-old", ["qwen-old", "qwen-new"]),
  ];
  const defaults = new Map(profiles.map((entry) => [entry.id, entry.defaultModel]));
  const byProfile = new Map(profiles.map((entry) => [entry.id, entry]));
  const records = new Map<string, SessionRecord>([[target.id, target], [caller.id, caller]]);
  const runtimes: SessionControlRuntime[] = [];
  const invalidated: string[] = [];
  const mutations: SessionConfigChanges[] = [];
  let nextSession = 1;

  const deps: ThreadSessionControlDeps = {
    store: {
      get: (id) => records.get(id),
      readConfig: (value) => JSON.parse(value.configJson || "{}") as SessionConfigState,
      upsert: (value) => { records.set(value.id, value); },
    },
    router: {
      describeConfig: (value) => description(records.get(value.id) ?? value, defaults),
      getProfile: (id) => byProfile.get(id),
      invalidate: async (id) => { invalidated.push(id); },
      getOrStartRuntime: async (value) => {
        const current = records.get(value.id) ?? value;
        const cfg = JSON.parse(current.configJson || "{}") as SessionConfigState;
        const sessionId = current.acpSessionId || `session-new-${nextSession++}`;
        if (!current.acpSessionId) records.set(current.id, { ...current, acpSessionId: sessionId });
        const selected = byProfile.get(current.agentId)!;
        const runtime = makeRuntime(
          sessionId,
          selected.staticModels?.map((entry) => entry.modelId) ?? [],
          opts.efforts ?? ["low", "high"]
        );
        // Keep the fake's effective model represented in persistence like the
        // real router; the runtime itself records live set calls separately.
        void cfg;
        runtimes.push(runtime);
        return runtime;
      },
    },
    mutation: {
      applySessionConfig: (value, changes) => {
        mutations.push(changes);
        const current = records.get(value.id) ?? value;
        const cfg = JSON.parse(current.configJson || "{}") as SessionConfigState;
        if (changes.model !== undefined) {
          if (changes.model === null) delete cfg.model;
          else cfg.model = changes.model;
        }
        if (changes.effort !== undefined) {
          if (changes.effort === null) delete cfg.reasoningEffort;
          else cfg.reasoningEffort = changes.effort;
        }
        records.set(value.id, {
          ...current,
          ...(changes.agent ? { agentId: changes.agent } : {}),
          configJson: JSON.stringify(cfg),
        });
        return {
          ok: true,
          result: {
            ok: true,
            message: "updated",
            auditId: "audit-1",
            fields: [],
            warnings: [],
          },
        };
      },
    },
  };

  return {
    caller,
    target,
    records,
    runtimes,
    invalidated,
    mutations,
    service: new ThreadSessionControlService(deps),
  };
}

describe("detectSessionReset", () => {
  it.each([
    ["claude", "codex", false, true, "agent-switch"],
    ["claude", "claude", true, false, undefined],
    ["copilot", "copilot", true, false, undefined],
    ["codex", "codex", true, true, "model-switch"],
    ["ollama-cloud", "ollama-cloud", true, true, "model-switch"],
    ["codex", "codex", false, false, undefined],
  ])(
    "%s -> %s (modelChanged=%s) resets=%s",
    (previousAgentId, nextAgentId, modelChanged, expected, reason) => {
      expect(detectSessionReset({ previousAgentId, nextAgentId, modelChanged })).toEqual({
        sessionReset: expected,
        ...(reason ? { resetReason: reason } : {}),
      });
    }
  );
});

describe("ThreadSessionControlService", () => {
  it("changes a Claude model live and applies only a live-advertised effort", async () => {
    const h = harness();
    const result = await h.service.configure(h.caller, h.target, {
      model: "claude-new",
      effort: "high",
    });

    expect(result).toMatchObject({
      ok: true,
      applied: { model: "claude-new", effort: "high" },
      sessionReset: false,
    });
    expect(h.invalidated).toEqual([]);
    expect(h.runtimes[0]!.modelCalls).toEqual(["claude-new"]);
    expect(h.runtimes[0]!.optionCalls).toEqual([["reasoning_effort", "high"]]);
    expect(h.mutations).toEqual([{ model: "claude-new", effort: "high" }]);
  });

  it("forges a fresh Codex session on model change", async () => {
    const h = harness({
      target: record({
        agentId: "codex",
        configJson: JSON.stringify({ model: "gpt-old", reasoningEffort: "low" }),
      }),
    });
    const result = await h.service.configure(h.caller, h.target, { model: "gpt-new" });

    expect(result).toMatchObject({
      ok: true,
      applied: { model: "gpt-new", effort: "low" },
      sessionReset: true,
      resetReason: "model-switch",
      newSessionId: "session-new-1",
    });
    expect(h.invalidated).toEqual([h.target.id]);
    expect(h.mutations).toEqual([
      { model: "gpt-new", effort: null },
      { effort: "low" },
    ]);
  });

  it("falls back to auto without sending an unsupported effort", async () => {
    const h = harness({ efforts: ["low"] });
    const result = await h.service.configure(h.caller, h.target, { effort: "ultra" });

    expect(result).toMatchObject({
      ok: true,
      applied: { effort: "auto" },
      sessionReset: false,
    });
    expect(result.ok && result.warnings.join(" ")).toContain("using auto");
    expect(h.runtimes[0]!.optionCalls).toEqual([]);
    expect(h.mutations).toEqual([{ effort: null }]);
  });

  it("agent switches always reset and default the model to the new profile", async () => {
    const h = harness();
    const result = await h.service.configure(h.caller, h.target, { agent: "codex" });

    expect(result).toMatchObject({
      ok: true,
      applied: { agent: "codex", model: "gpt-old", effort: "low" },
      sessionReset: true,
      resetReason: "agent-switch",
      newSessionId: "session-new-1",
    });
    expect(h.mutations[0]).toEqual({ agent: "codex", model: "gpt-old", effort: null });
  });

  it("reset forges a new session while preserving effective agent and model", async () => {
    const h = harness();
    const result = await h.service.reset(h.target);

    expect(result).toEqual({
      ok: true,
      sessionReset: true,
      newSessionId: "session-new-1",
      agent: "claude",
      model: "claude-old",
    });
    expect(h.invalidated).toEqual([h.target.id]);
    expect(h.mutations).toEqual([]);
  });
});
