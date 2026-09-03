import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  AGENT_ADAPTER_VERSION,
  asLocalAdapter,
  makeAgyProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
} from "@seam/adapters";

/** A bare local adapter: no sessionManager, no effort, no staticModels.
 *  #12 retired opencode, which used to be the stand-in for this shape — but the
 *  contract it exercised (asLocalAdapter's defaults) is generic, so build the
 *  minimal profile directly rather than borrowing whichever agent happens to
 *  lack a session manager. */
const bareProfile = (defaultModel: string) =>
  asLocalAdapter({
    id: "bare",
    displayName: "bare",
    defaultModel,
    effort: { mechanism: "none", levels: [] },
    spawn: () => spawn("true", [], { stdio: ["pipe", "pipe", "pipe"] }),
  });

describe("AgentAdapter.describe()", () => {
  it("uses the current adapter contract version", () => {
    expect(AGENT_ADAPTER_VERSION).toBe(2);
  });

  it("claude reports meta effort and static models (with contextLimit)", () => {
    const profile = makeClaudeProfile({
      defaultModel: "default",
      staticModels: [
        { modelId: "default", name: "Opus latest" },
        { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      ],
    });
    const d = profile.describe();
    expect(d.version).toBe(AGENT_ADAPTER_VERSION);
    expect(d.effort.mechanism).toBe("meta");
    expect(d.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(d.models).toEqual([
      { modelId: "default", name: "Opus latest", contextLimit: 1_000_000 },
      { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", contextLimit: 200_000 },
    ]);
  });

  it("claude variants round-trip their effort override (zai = none; ollama-cloud = meta)", () => {
    const zai = makeClaudeProfile({
      id: "zai",
      defaultModel: "glm-5",
      effort: { mechanism: "none", levels: [] },
    });
    expect(zai.id).toBe("zai");
    expect(zai.describe().effort.mechanism).toBe("none");
    expect(zai.describe().effort.levels).toEqual([]);

    const ollamaCloud = makeClaudeProfile({
      id: "ollama-cloud",
      defaultModel: "kimi-k3:cloud",
      effort: {
        mechanism: "meta",
        levels: ["low", "medium", "high", "max"],
      },
    });
    expect(ollamaCloud.describe().effort.mechanism).toBe("meta");
    expect(ollamaCloud.describe().effort.levels).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);

    const vertex = makeClaudeProfile({
      id: "claude-vertex",
      defaultModel: "default",
    });
    expect(vertex.describe().effort.mechanism).toBe("meta");
  });

  it("copilot reports configOption + reasoning_effort", () => {
    const d = makeCopilotProfile({ defaultModel: "gpt-5" }).describe();
    expect(d.effort.mechanism).toBe("configOption");
    expect(d.effort.configId).toBe("reasoning_effort");
    expect(d.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("agy reports modelBaked", () => {
    const d = makeAgyProfile().describe();
    expect(d.effort.mechanism).toBe("modelBaked");
    expect(d.effort.levels).toEqual([]);
  });

  it("a bare local adapter reports none and falls back to defaultModel", () => {
    const d = bareProfile("some-model").describe();
    expect(d.effort.mechanism).toBe("none");
    expect(d.models).toEqual([{ modelId: "some-model", name: "some-model" }]);
  });

  it("codex reports configOption + reasoning_effort", () => {
    const d = makeCodexProfile({ defaultModel: "o3" }).describe();
    expect(d.effort.mechanism).toBe("configOption");
    expect(d.effort.configId).toBe("reasoning_effort");
  });

  it("grok reports spawnArgs so describe() round-trips the CLI-flag mechanism", () => {
    const d = makeGrokProfile({
      defaultModel: "grok-4.6",
      staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 }],
    }).describe();
    expect(d.effort.mechanism).toBe("spawnArgs");
    expect(d.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(d.models).toEqual([
      { modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 },
    ]);
  });
});

describe("AgentAdapter local stubs + session delegates", () => {
  it("does not install, enumerate workspaces, or ferry attachments", async () => {
    const grok = makeGrokProfile({ defaultModel: "grok-4.6" });
    expect(grok.prepare()).toEqual([]);
    expect(grok.install()).toEqual({ supported: false });
    expect(grok.listWorkspaces()).toEqual([]);
    await expect(grok.readAttachment("/tmp", "x.txt")).resolves.toBeNull();
    await expect(grok.writeAttachment("/tmp", "x.txt", "Zg==")).resolves.toBeNull();
  });

  it("usage() is null without sessionManager.getUsage", async () => {
    await expect(bareProfile("x").usage("/tmp")).resolves.toBeNull();
  });

  it("codex usage() delegates to sessionManager even when the sessions dir is empty", async () => {
    const u = await makeCodexProfile({
      defaultModel: "o3",
      sessionsRoot: "/tmp/seam-codex-sessions-does-not-exist",
    }).usage("/tmp");
    expect(u).toEqual({ model: null, totalUsed: 0, contextLimit: 0 });
  });

  it("session verbs no-op when there is no sessionManager", async () => {
    const p = bareProfile("x");
    await expect(p.listSessions("/tmp")).resolves.toEqual([]);
    await expect(p.getTranscript("/tmp", "s")).resolves.toBe("");
    await expect(p.cloneSession("/tmp", "a", "b")).resolves.toBeUndefined();
    await expect(p.deleteSession("/tmp", "s")).resolves.toBeUndefined();
  });

  it("keeps spawn(modelOverride?, effortOverride?) as the runtime signature", () => {
    const grok = makeGrokProfile({ defaultModel: "grok-4.6" });
    expect(typeof grok.spawn).toBe("function");
    expect(grok.spawn.length).toBe(2);
  });
});
